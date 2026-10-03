// Second verification at the privileged boundary. The gateway can enqueue but
// cannot sign: it holds only the public key. No unverified request drives root.
import {readFile} from 'node:fs/promises';
import {verifiedRequest} from '../../services/access/src/incidents.mjs';
const nonce=process.argv[2];if(!/^[0-9a-f]{32}$/.test(nonce))throw new Error('Invalid approval id');
const chunks=[];for await(const c of process.stdin)chunks.push(c);
const g=JSON.parse(Buffer.concat(chunks));
const issued=JSON.parse(await readFile(`/control/grants/${nonce}.json`,'utf8'));
const key=await readFile('/control/public-key.pem','utf8');
process.stdout.write(JSON.stringify(verifiedRequest(g,issued,key,nonce))+'\n');
