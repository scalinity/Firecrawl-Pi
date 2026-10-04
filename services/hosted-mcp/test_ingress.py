import asyncio
import hashlib
import importlib.util
import unittest
from unittest.mock import AsyncMock, patch
from pathlib import Path

spec = importlib.util.spec_from_file_location('ingress', Path(__file__).with_name('ingress.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
TOKEN = 'synthetic-hosted-fixture-' + 'a' * 64
HOST = 'fixture.example.ts.net:10000'


class Writer:
    def __init__(self):
        self.data = b''
        self.closed = False

    def write(self, data):
        self.data += data

    async def drain(self):
        pass

    def close(self):
        self.closed = True


class Tests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.ingress = module.Ingress({'host': HOST, 'token_sha256': hashlib.sha256(TOKEN.encode()).hexdigest()})

    async def request(self, path='/mcp', auth=TOKEN, headers=None, body=b'{}', method='POST', response=b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}'):
        source = asyncio.StreamReader(limit=module.HEADER_BYTES)
        header = {'Host': HOST, 'Authorization': 'Bearer ' + auth, 'Content-Length': str(len(body))}
        header.update(headers or {})
        data = f'{method} {path} HTTP/1.1\r\n' + ''.join(f'{k}: {v}\r\n' for k, v in header.items()) + '\r\n'
        source.feed_data(data.encode() + body)
        reply = Writer()
        upstream_reader = asyncio.StreamReader()
        upstream_reader.feed_data(response)
        upstream_reader.feed_eof()
        upstream = Writer()
        with patch.object(module.asyncio, 'open_connection', AsyncMock(return_value=(upstream_reader, upstream))) as connect:
            await self.ingress.handle(source, reply)
        return reply, upstream, connect

    async def test_only_exact_mcp_path(self):
        for path in ['/', '/health', '/v2/scrape', '/admin', '/platform/v1/artifacts/x', '/mcp?url=x', '/mcp/', '/%6dcp', 'http://evil/mcp', '/mcp/../v2/scrape']:
            reply, _, connect = await self.request(path=path)
            self.assertTrue(reply.data.startswith(b'HTTP/1.1 404'), path)
            connect.assert_not_called()

    async def test_bad_auth_rate_limit_and_valid_positive_control(self):
        for i in range(31):
            reply, _, connect = await self.request(auth='wrong-synthetic-token')
            self.assertTrue(reply.data.startswith(b'HTTP/1.1 ' + (b'401' if i < 30 else b'429')))
            connect.assert_not_called()
        reply, _, connect = await self.request()
        self.assertTrue(reply.data.startswith(b'HTTP/1.1 200'))
        connect.assert_awaited_once()

    async def test_host_and_framing_limits(self):
        for headers, status in [({'Host': 'evil.test'}, 421), ({'Content-Length': '1048577'}, 413),
                                ({'Transfer-Encoding': 'chunked'}, 400), ({'Expect': '100-continue'}, 400),
                                ({'authorization': 'Bearer '+TOKEN}, 400), ({'Content-Length': '-1'}, 400),
                                ({'X-Huge': 'a'*16384}, 431)]:
            reply, _, connect = await self.request(headers=headers)
            self.assertTrue(reply.data.startswith(f'HTTP/1.1 {status}'.encode()))
            connect.assert_not_called()

    async def test_fixed_upstream_identity_stripping_and_modern_headers(self):
        reply, upstream, connect = await self.request(headers={'X-Fcpi-Principal': 'owner', 'X-Forwarded-Host': 'evil',
                                                               'Mcp-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/list', 'Mcp-Param-Name': 'x'})
        connect.assert_awaited_once_with('127.0.0.1', 3380, limit=module.HEADER_BYTES)
        self.assertIn(b'host: 127.0.0.1:3380', upstream.data)
        self.assertIn(b'mcp-protocol-version: 2026-07-28', upstream.data)
        self.assertIn(b'mcp-param-name: x', upstream.data)
        self.assertNotIn(b'evil', upstream.data)
        self.assertNotIn(b'x-fcpi-principal', upstream.data)
        self.assertNotIn(b'Mcp-Session-Id', reply.data)
        self.assertEqual(self.ingress.active, 0)

    async def test_redirect_refused_and_permit_released(self):
        reply, upstream, _ = await self.request(response=b'HTTP/1.1 302 Found\r\nLocation: https://evil.test\r\n\r\n')
        self.assertTrue(reply.data.startswith(b'HTTP/1.1 502'))
        self.assertNotIn(b'evil', reply.data)
        self.assertTrue(upstream.closed)
        self.assertEqual(self.ingress.active, 0)

    async def test_sse_and_legacy_pass_without_session(self):
        response = b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: {"result":{}}\n\n'
        reply, upstream, _ = await self.request(headers={'Mcp-Protocol-Version': '2025-11-25'}, response=response)
        self.assertEqual(reply.data, response)
        self.assertIn(b'mcp-protocol-version: 2025-11-25', upstream.data)

    async def test_overload_denies_without_queue(self):
        self.ingress.active = 2
        reply, _, connect = await self.request()
        self.assertTrue(reply.data.startswith(b'HTTP/1.1 503'))
        connect.assert_not_called()
        self.assertEqual(self.ingress.active, 2)

    async def test_disconnect_closes_upstream_before_headers_and_between_sse(self):
        for response in (b'', b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\ndata: progress\n\n'):
            source = asyncio.StreamReader()
            source.feed_data(f'POST /mcp HTTP/1.1\r\nHost: {HOST}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: 2\r\n\r\n{{}}'.encode())
            upstream_reader = asyncio.StreamReader()
            if response:
                upstream_reader.feed_data(response)
            upstream = Writer()
            with patch.object(module.asyncio, 'open_connection', AsyncMock(return_value=(upstream_reader, upstream))):
                task = asyncio.create_task(self.ingress.handle(source, Writer()))
                while not upstream.data:
                    await asyncio.sleep(0)
                source.feed_eof()
                await asyncio.wait_for(task, 1)
            self.assertTrue(upstream.closed)
            self.assertEqual(self.ingress.active, 0)
            self.assertEqual(self.ingress.connections, 0)


if __name__ == '__main__':
    unittest.main()
