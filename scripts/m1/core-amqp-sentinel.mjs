// Runs INSIDE firecrawl-core as root (docker exec -i -u 0 <core> node --input-type=module - < core-amqp-sentinel.mjs),
// using upstream's own amqplib and the core's broker credential file.
//   SENTINEL_MODE=write SENTINEL_VALUE=<v>: declare durable quorum queue fcpi.m1.sentinel and
//     publish one persistent message with publisher confirms;
//   SENTINEL_MODE=read: basic.get the head message, print it, and requeue it (nack), so reading
//     never consumes the sentinel.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const amqp = createRequire("/app/package.json")("amqplib");
const QUEUE = "fcpi.m1.sentinel";
const url = readFileSync("/run/secrets/core_nuq_rabbitmq_url", "utf8").trim();
const conn = await amqp.connect(url, { clientProperties: { connection_name: "fcpi-m1-sentinel" } });
const ch = await conn.createConfirmChannel();
const q = await ch.assertQueue(QUEUE, { durable: true, arguments: { "x-queue-type": "quorum" } });
const out = { utc: new Date().toISOString(), queue: QUEUE, messages_before: q.messageCount };
if (process.env.SENTINEL_MODE === "write") {
  ch.sendToQueue(QUEUE, Buffer.from(process.env.SENTINEL_VALUE, "utf8"), { persistent: true, contentType: "text/plain" });
  await ch.waitForConfirms();
  out.published = process.env.SENTINEL_VALUE;
  out.confirmed = true;
} else {
  const m = await ch.get(QUEUE, { noAck: false });
  out.head_message = m ? m.content.toString("utf8") : null;
  out.redelivered = m ? m.fields.redelivered : null;
  if (m) ch.nack(m, false, true);
}
await ch.close();
await conn.close();
console.log(JSON.stringify(out));
