// Second verification at the privileged boundary. The gateway can enqueue but
// cannot sign: it holds only the public key. No unverified request drives root.
import {readFile} from 'node:fs/promises';
import {validGrant,verifySignature} from '../../services/access/src/incidents.mjs';
const nonce=process.argv[2];if(!/^[0-9a-f]{32}$/.test(nonce))throw new Error('Invalid approval id');
const chunks=[];for await(const c of process.stdin)chunks.push(c);
const g=JSON.parse(Buffer.concat(chunks));
const issued=JSON.parse(await readFile(`/control/grants/${nonce}.json`,'utf8'));
const key=await readFile('/control/public-key.pem','utf8');
const fields=['schema','id','incident_id','action','base_sha','patch_sha','tests_sha','issued_at','expires_at'];
if(g.id!==nonce || !validGrant(g) || fields.some(k=>g[k]!==issued[k]) || !verifySignature(key,g,g.signature)
 || !Number.isSafeInteger(g.approved_at) || g.approved_at<g.issued_at || g.approved_at>=g.expires_at || g.approved_at>Date.now())throw new Error('Approval proof rejected');
process.stdout.write(JSON.stringify(Object.fromEntries([...fields,'approved_at'].map(k=>[k,g[k]])))+'\n');
