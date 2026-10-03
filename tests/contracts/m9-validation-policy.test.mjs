import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { loadBudgetPolicy, paidDispatchActive } from "../../services/retrieval/src/budget.mjs";

test("the actual M9 window policy generator satisfies the production validator and owner bounds", () => {
  const script = readFileSync(new URL("../../scripts/m9/validation.sh", import.meta.url), "utf8");
  const expression = script.match(/jq --argjson g "\$g" '([^']+)' "\$R\/deploy\/policies\/budget\.json"/)?.[1];
  assert.ok(expression, "exercise the deployed jq expression");
  const grant = { expires_at: "2026-10-03T18:00:00Z", llm_micro_usd: 20000, proxy_micro_usd: 100000, enhanced_micro_usd: 100000, parser_credits: 20 };
  const result = spawnSync("jq", ["--argjson", "g", JSON.stringify(grant), expression], {
    input: readFileSync(new URL("../../deploy/policies/budget.json", import.meta.url)), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const policy = loadBudgetPolicy(result.stdout);
  for (const [name, amount] of [["llm", 20000], ["proxy", 100000], ["enhanced", 100000]]) assert.deepEqual(policy.categories[name].caps, { day: amount, month: amount });
  assert.deepEqual(policy.paidTotal.caps, { day: 220000 });
  assert.deepEqual(policy.categories.parser.caps, { month: 20 });
  assert.equal(policy.parsing.maxPages, 2);
  assert.equal(policy.rateCards.find(card => card.subject === "llamaparse-cost-effective").microUsdPerCredit, 0);
  assert.equal(paidDispatchActive(policy, true, Date.parse(grant.expires_at) - 1), true);
  assert.equal(paidDispatchActive(policy, true, Date.parse(grant.expires_at)), false);
  assert.equal(paidDispatchActive(policy, false, Date.parse(grant.expires_at) - 1), false);
});
