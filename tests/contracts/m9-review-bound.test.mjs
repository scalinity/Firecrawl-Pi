import test from 'node:test';import assert from 'node:assert/strict';import{reviewVerdict}from'../../scripts/m9/evidence-checks.mjs';
const ids='DB1-C1 DB1-C2 DB1-C3 DB1-C4 DB1-C5 DB1-W1 DB1-W2 DB1-W3 DB1-W4 DB1-W5 DB1-W6 DB1-S1 DB1-S2 DB1-S3 DB1-S4 DB1-S5 DB1-S6 DB1-S7 DB1-S8 DB1-S9 CA1-C1 CA1-C2 CA1-C3 CA1-C4 CA1-W1 CA1-W2 CA1-W3 CA1-W4 CA1-W5 CA1-W6 CA1-W7 CA1-W8 CA1-W9 CA1-W10 CA1-S1 CA1-S2 CA1-S3 CA1-S4 CA1-S5 CA1-S6 CA1-S7 SELF-01 SELF-02'.split(' ');
const base='Remediation complete\n| Finding | Disposition | Evidence |\n| --- | --- | --- |\n'+ids.map(id=>`| ${id} | FIXED | commit/proof |`).join('\n');
test('complete reviews and padded or optional table bars preserve returned blockers',()=>{
 for(const row of ['| M9-REG-12 | RETURNED | M2 owns fix |','| M9-REG-12        | RETURNED    | M2 owns fix |','M9-REG-12 | RETURNED | M2 owns fix','| M9-REG-12 | RETURNED | M2 owns fix']){
  const r=reviewVerdict(base+'\n'+row);assert.equal(r.complete,true);assert.deepEqual(r.returned,['M9-REG-12']);
 }
 assert.equal(reviewVerdict(base).complete,true);
});
test('pending, duplicate, malformed and missing findings cannot disappear',()=>{
 for(const row of ['| M9-REG-12 | PENDING | proof |','| M9-REG-12 | FIXED pending verification | proof |','| M9-REG-12 (new) | RETURNED | proof |','| **M9-REG-12** | RETURNED | proof |','| DELTA-W1 | FIXED | proof |','| Finding | RETURNED | proof |','| M9-REG-12 |'])assert.equal(reviewVerdict(base+'\n'+row).complete,false,row);
 for(const report of [base.replace('DB1-C1 | FIXED','DB1-C1 / CA1-C1 | PENDING'),base.replace('DB1-C1 | FIXED','DB1-C99 | FIXED'),base.replace('| DB1-C1 | FIXED | commit/proof |\n',''),base+'\n| DB1-C1 | FIXED | proof |',base.replace('Remediation complete','pending')])assert.equal(reviewVerdict(report).complete,false);
 assert.deepEqual(reviewVerdict(base+'\n| **M9-REG-12** | RETURNED | proof |').returned,['**M9-REG-12**']);
 assert.equal(reviewVerdict('').complete,false);
});
