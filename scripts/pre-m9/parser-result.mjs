#!/usr/bin/env node
// Read the already charged complex fixture's retained result; makes no provider request.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const base = "evidence/M5/pre-m9-closure/";
const input = readFileSync(`${base}raw/e2e-live.txt`, "utf8");
const event = input.split("\n").filter(l => l.startsWith("{"))
  .flatMap(l => JSON.parse(l).events ?? []).find(e => e.event === "parse" && e.reason === "complex_layout" && e.outcome === "COMPLETED");
if (!/^doc:[a-f0-9-]{36}$/.test(event?.logical_id ?? "")) throw new Error("missing validated complex parse event");
const t = Object.fromEntries(readFileSync("scripts/m1/pi-target.conf", "utf8").split("\n").filter(l => /^PI_\w+=/.test(l))
  .map(l => [l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1).replace("$HOME",process.env.HOME)]));
const q = `SELECT row_to_json(r) FROM (SELECT logical_id,state,actual,usage,result->>'markdown' AS markdown FROM fcpi_retrieval.budget_reservation WHERE logical_id='${event.logical_id}' AND category='parser') r`;
const raw = execFileSync("ssh", ["-i",t.PI_SSH_KEY,"-o","IdentitiesOnly=yes","-o","BatchMode=yes",t.PI_SSH_TARGET,
  "sudo -n docker exec -i fcpi-nuq-postgres-1 psql -U postgres -d postgres -q -At -X -v ON_ERROR_STOP=1"], {input:q,encoding:"utf8"}).trim();
const result = JSON.parse(raw);
if (result.state !== "SETTLED" || typeof result.markdown !== "string") throw new Error("complex result not retained and settled");
writeFileSync(`${base}raw/parser-result.json`,JSON.stringify({utc:new Date().toISOString(),probe:"read-only retained result; zero new dispatch",source_sha:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),
  input_sha256:createHash("sha256").update(input).digest("hex"), ...result, markdown_sha256:createHash("sha256").update(result.markdown).digest("hex")},null,2)+"\n");
console.log("retained complex fixture proof saved; no provider request");
