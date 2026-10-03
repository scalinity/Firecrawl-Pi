// Second verification at the privileged boundary. Infrastructure errors stay
// retryable; malformed, expired or mismatched proofs have a distinct exit code.
import {readFile} from 'node:fs/promises';
import {verifiedRequest} from '../../services/access/src/incidents.mjs';
const nonce=process.argv[2];
if(!/^[0-9a-f]{32}$/.test(nonce??''))process.exit(3);
let issued,key;
try{issued=JSON.parse(await readFile(`/control/grants/${nonce}.json`,'utf8'));key=await readFile('/control/public-key.pem','utf8');}catch{process.exit(1);}
try{const chunks=[];for await(const c of process.stdin)chunks.push(c);const g=JSON.parse(Buffer.concat(chunks));process.stdout.write(JSON.stringify(verifiedRequest(g,issued,key,nonce))+'\n');}catch{process.exit(3);}
