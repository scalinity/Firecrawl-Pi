// The native parent owns stdin. EOF also covers an unexpected parent exit.
import { startServer } from './server.mjs';

if (Number(process.versions.node.split('.')[0]) < 22) throw Error('FCPI_NODE_TOO_OLD');
const server = await startServer({ port: 0 });
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.stdin.resume();
process.stdin.once('end', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/LLM-DEMO.html` }) + '\n');
