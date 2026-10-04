"""MCP-only loopback boundary for Claude Funnel; no redirects or selectable upstream."""
import asyncio
import hashlib
import hmac
import json
import re
import sys
import time
from datetime import datetime, timezone

HEADER_BYTES = 16384
BODY_BYTES = 1048576
RESPONSE_BYTES = 8388608
FORWARD = {"authorization", "content-type", "accept", "origin",
           "mcp-protocol-version", "mcp-method", "mcp-name"}


class Refusal(Exception):
    def __init__(self, status):
        self.status = status


class CallerGone(Exception):
    pass


class Ingress:
    def __init__(self, config):
        if set(config) != {"host", "token_sha256"}:
            raise ValueError("invalid ingress configuration")
        if not re.fullmatch(r"[a-z0-9.-]+\.ts\.net:10000", config["host"]):
            raise ValueError("expected dedicated Funnel host on port 10000")
        if not re.fullmatch(r"[0-9a-f]{64}", config["token_sha256"]):
            raise ValueError("expected dedicated token digest")
        self.config = config
        self.connections = 0
        self.active = 0
        self.failure_window = time.monotonic()
        self.failures = 0

    async def refusal(self, writer, status):
        body = json.dumps({"success": False, "status": status}).encode()
        retry = b"Retry-After: 60\r\n" if status == 429 else b""
        writer.write(f"HTTP/1.1 {status} Refused\r\n".encode() + retry +
                     b"Content-Type: application/json\r\nConnection: close\r\n" +
                     f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        async with asyncio.timeout(5):
            await writer.drain()

    def bad_auth(self):
        now = time.monotonic()
        if now - self.failure_window >= 60:
            self.failure_window, self.failures = now, 0
        self.failures += 1
        raise Refusal(429 if self.failures > 30 else 401)

    async def handle(self, reader, writer):
        upstream = None
        sent = False
        admitted = False
        status = 503
        forward_task = None
        watch_task = None
        outcome = "refused"
        self.connections += 1
        try:
            if self.connections > 8:
                raise Refusal(503)
            async with asyncio.timeout(10):
                try:
                    raw = await reader.readuntil(b"\r\n\r\n")
                except (asyncio.LimitOverrunError, asyncio.IncompleteReadError):
                    raise Refusal(431)
                if len(raw) > HEADER_BYTES:
                    raise Refusal(431)
                lines = raw.decode("ascii").split("\r\n")
                parts = lines[0].split(" ")
                if len(parts) != 3 or parts[2] != "HTTP/1.1":
                    raise Refusal(400)
                method, path, _ = parts
                if path != "/mcp":
                    raise Refusal(404)
                if method not in {"POST", "GET", "DELETE"}:
                    raise Refusal(405)
                headers = {}
                for line in lines[1:-2]:
                    name, sep, value = line.partition(":")
                    name = name.lower()
                    if not sep or not re.fullmatch(r"[a-z0-9!#$%&'*+.^_`|~-]+", name):
                        raise Refusal(400)
                    value = value.strip(" \t")
                    if name in headers or re.search(r"[\x00-\x1f\x7f]", value):
                        raise Refusal(400)
                    headers[name] = value
                if headers.get("host", "").lower() != self.config["host"]:
                    raise Refusal(421)
                token = re.fullmatch(r"Bearer ([\x21-\x7e]{16,512})", headers.get("authorization", ""))
                digest = hashlib.sha256((token[1] if token else "invalid").encode()).hexdigest()
                if not hmac.compare_digest(digest, self.config["token_sha256"]) or not token:
                    self.bad_auth()
                if "transfer-encoding" in headers or "expect" in headers:
                    raise Refusal(400)
                length = headers.get("content-length", "0")
                if not re.fullmatch(r"[0-9]{1,10}", length):
                    raise Refusal(400)
                length = int(length)
                if length > BODY_BYTES:
                    raise Refusal(413)
                if method != "POST" and length:
                    raise Refusal(400)
                if self.active >= 2:
                    raise Refusal(503)
                self.active += 1
                admitted = True
                body = await reader.readexactly(length)
            async def forward_response():
                nonlocal upstream, sent, status, outcome
                ur, upstream = await asyncio.open_connection("127.0.0.1", 3380, limit=HEADER_BYTES)
                forward = {k: v for k, v in headers.items()
                           if k in FORWARD or re.fullmatch(r"mcp-param-[a-z0-9-]{1,64}", k)}
                forward.update({"host": "127.0.0.1:3380", "connection": "close", "content-length": str(length)})
                request = f"{method} /mcp HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in forward.items()) + "\r\n"
                upstream.write(request.encode("ascii") + body)
                await upstream.drain()
                response = await ur.readuntil(b"\r\n\r\n")
                if len(response) > HEADER_BYTES:
                    raise Refusal(502)
                status = int(response.split(b" ", 2)[1])
                # A redirect is never forwarded to a hosted caller (including its Location).
                if 300 <= status < 400:
                    raise Refusal(502)
                writer.write(response)
                sent = True
                size = len(response)
                while True:
                    chunk = await ur.read(32768)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > RESPONSE_BYTES:
                        outcome = "response_too_large"
                        break
                    writer.write(chunk)
                    await writer.drain()
                if outcome != "response_too_large":
                    outcome = "completed"
            forward_task = asyncio.create_task(forward_response())
            watch_task = asyncio.create_task(reader.read(1))
            async with asyncio.timeout(130):
                done, _ = await asyncio.wait({forward_task, watch_task}, return_when=asyncio.FIRST_COMPLETED)
                if watch_task in done:
                    if watch_task.result():
                        raise Refusal(400)
                    raise CallerGone()
                await forward_task
        except CallerGone:
            status, outcome = 499, "cancelled"
        except Refusal as exc:
            status = exc.status
            if not sent:
                await self.refusal(writer, status)
        except (TimeoutError, OSError, ValueError, UnicodeError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
            status = 502
            if not sent:
                try:
                    await self.refusal(writer, status)
                except OSError:
                    pass
        finally:
            for task in (forward_task, watch_task):
                if task is not None:
                    task.cancel()
            await asyncio.gather(*(task for task in (forward_task, watch_task) if task is not None), return_exceptions=True)
            if admitted:
                self.active -= 1
            self.connections -= 1
            if upstream:
                upstream.close()
            writer.close()
            print(json.dumps({"utc": datetime.now(timezone.utc).isoformat(),
                              "service": "hosted-mcp-ingress", "status": status, "outcome": outcome}), flush=True)


async def main():
    with open(sys.argv[1], encoding="utf-8") as source:
        ingress = Ingress(json.load(source))
    server = await asyncio.start_server(ingress.handle, "127.0.0.1", 3381, limit=HEADER_BYTES)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
