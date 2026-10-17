// scripts/host/firewall-fingerprint.py: the canonical hash ignores the order of rules where order cannot matter (a chain
// whose rules all end in the same verdict) and nothing else. The rulesets are synthetic, shaped like `nft -s list ruleset`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const SCRIPT = new URL("../scripts/host/firewall-fingerprint.py", import.meta.url).pathname;
const run = (input, ...args) => spawnSync("python3", ["-I", SCRIPT, ...args], { input, encoding: "utf8" });
const fingerprint = (input) => Object.fromEntries(run(input).stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

// Three Docker-style drop rules (independent: one verdict, no continuation) and a project-style chain that mixes verdicts.
const A = 'ip daddr 192.0.2.10 iifname != "br-a" counter drop';
const B = 'ip daddr 192.0.2.11 iifname != "br-b" counter drop';
const C = 'ip daddr 192.0.2.11 iifname != "lo" tcp dport 3380 counter drop';
const G1 = 'iifname "fcpi-egress" ip daddr @egress_local_v4 counter drop comment "egress_local_dropped"';
const G2 = 'iifname "fcpi-egress" counter accept';
const J1 = "fib daddr type local counter jump DOCKER";
const J2 = "ip daddr 192.0.2.99 counter jump OTHER";
const ruleset = ({ raw = [A, B, C], guard = [G1, G2], nat = [J1, J2], warn = false } = {}) => `${warn ? "# Warning: table ip filter is managed by iptables-nft, do not touch!\n" : ""}table ip raw {
	chain PREROUTING {
		type filter hook prerouting priority raw; policy accept;
${raw.map((r) => `\t\t${r}`).join("\n")}
	}
}
table ip nat {
	chain PREROUTING {
		type nat hook prerouting priority dstnat; policy accept;
${nat.map((r) => `\t\t${r}`).join("\n")}
	}
}
table inet fcpi_guard {
	set egress_local_v4 {
		type ipv4_addr
		flags interval
		elements = { 10.0.0.0/8, 192.168.0.0/16 }
	}
	chain forward {
		type filter hook forward priority filter - 10; policy accept;
${guard.map((r) => `\t\t${r}`).join("\n")}
	}
}
`;

test("re-ordering rules that all end in the same verdict changes the raw hash and not the canonical one", () => {
  const base = fingerprint(ruleset());
  const swapped = fingerprint(ruleset({ raw: [C, A, B] }));
  assert.notEqual(base.nft_ruleset_sha256, swapped.nft_ruleset_sha256, "precondition: the raw hash does see the order");
  assert.equal(base.nft_ruleset_canonical_sha256, swapped.nft_ruleset_canonical_sha256);
  assert.equal(base.guard_table_sha256, swapped.guard_table_sha256);
  assert.match(base.order_insensitive_chains, /^1 ip raw\/PREROUTING$/, "only the all-drop chain is sorted");
});

test("a real change in an all-drop chain is still seen: an edited rule, a removed rule, an added rule", () => {
  const base = fingerprint(ruleset()).nft_ruleset_canonical_sha256;
  for (const [why, raw] of [
    ["a port edited", [A, B, C.replace("3380", "3381")]],
    ["an interface edited", [A, B.replace("br-b", "br-x"), C]],
    ["a rule removed", [A, B]],
    ["a rule added", [A, B, C, 'ip daddr 192.0.2.12 iifname != "br-c" counter drop']],
    ["a rule duplicated", [A, A, B, C]],
  ]) assert.notEqual(fingerprint(ruleset({ raw })).nft_ruleset_canonical_sha256, base, why);
});

test("where verdicts differ the order decides the outcome, so it is kept: swapping a drop and an accept changes the fingerprint", () => {
  const base = fingerprint(ruleset());
  const swapped = fingerprint(ruleset({ guard: [G2, G1] }));
  assert.notEqual(base.nft_ruleset_canonical_sha256, swapped.nft_ruleset_canonical_sha256);
  assert.notEqual(base.guard_table_sha256, swapped.guard_table_sha256, "the project's own table is hashed in its listed order");
  assert.doesNotMatch(base.order_insensitive_chains, /fcpi_guard/);
});

test("rules that continue evaluation (a jump) are never sorted", () => {
  const base = fingerprint(ruleset());
  const swapped = fingerprint(ruleset({ nat: [J2, J1] }));
  assert.notEqual(base.nft_ruleset_canonical_sha256, swapped.nft_ruleset_canonical_sha256);
  assert.doesNotMatch(base.order_insensitive_chains, /ip nat/);
});

test("nft\x27s warnings about iptables-managed tables are not rules, and empty input is refused", () => {
  assert.equal(fingerprint(ruleset({ warn: true })).nft_ruleset_sha256, fingerprint(ruleset()).nft_ruleset_sha256);
  const none = run("");
  assert.equal(none.status, 2);
  assert.match(none.stderr, /no ruleset/);
});

test("--canonical prints the text with the order-insensitive chain sorted, for diffing two states", () => {
  const a = run(ruleset({ raw: [A, B, C] }), "--canonical").stdout;
  const b = run(ruleset({ raw: [C, B, A] }), "--canonical").stdout;
  assert.equal(a, b);
  const rules = a.split("\n").filter((l) => /counter drop$/.test(l) && l.includes("192.0.2.1"));
  assert.deepEqual(rules, [...rules].sort(), "the three drop rules appear in sorted order");
});
