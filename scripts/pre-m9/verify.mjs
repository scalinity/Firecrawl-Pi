#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { ROOT, repoState, sha256File } from "../m0/lib.mjs";
import { closureVerdicts } from "./verdicts.mjs";
const files = [5,6,7].map(m=>`evidence/M${m}/pre-m9-closure/raw/e2e-live.txt`);
const records = p => {
  const out={}; let section;
  if (!existsSync(`${ROOT}/${p}`)) return out;
  for (const l of readFileSync(`${ROOT}/${p}`,"utf8").split("\n")) {
    const h=/^### (\S+)$/.exec(l); if(h){section=h[1];out[section]??=[];}
    else if(section && l.startsWith("{")) out[section].push(JSON.parse(l));
  }
  return out;
};
const e=files.map(records), verdicts=closureVerdicts(...e);
const out={ utc:new Date().toISOString(), ...repoState(), scope:"PRE-M9 additional proofs; no M9 acceptance", inputs:files.map(p=>({path:p,sha256:existsSync(`${ROOT}/${p}`)?sha256File(p):null})),
  patch_sha256:sha256File("patches/series.json"), configuration_sha256:sha256File("deploy/policies/budget.json"),
  fixture_sha256:sha256File("tests/fixtures/m5/documents.mjs"), retrieval_image:JSON.parse(readFileSync(`${ROOT}/deploy/versions.lock.json`)).images.retrieval,
  tests:verdicts };
writeFileSync(`${ROOT}/evidence/M5/pre-m9-closure/additional-verification.json`,JSON.stringify(out,null,2)+"\n");
for(const [id,r] of Object.entries(verdicts)) console.log(`${id} ${r.state}${r.failed.length?` (${r.failed.join(",")})`:""}`);
process.exitCode=Object.values(verdicts).every(r=>r.state==="PASS")?0:1;
