// scripts/host/firewall-fingerprint.py: the canonical hash ignores the order of rules only where order cannot matter (a chain
// whose rules are all pure matches ending in one shared verdict) and nothing else. The rulesets are synthetic, shaped like
// `nft -s list ruleset`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const SCRIPT = new URL("../scripts/host/firewall-fingerprint.py", import.meta.url).pathname;
const run = (input, ...args) => spawnSync("python3", ["-I", SCRIPT, ...args], { input, encoding: "utf8" });
const fingerprint = (input) => Object.fromEntries(run(input).stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

// Docker's own shape: three independent pure-match drop rules.
const A = 'ip daddr 192.0.2.10 iifname != "br-a" counter drop';
const B = 'ip daddr 192.0.2.11 iifname != "br-b" counter drop';
const C = 'ip daddr 192.0.2.11 iifname != "lo" tcp dport 3380 counter drop';
// The project's own chain mixes verdicts.
const G1 = 'iifname "fcpi-egress" ip daddr @egress_local_v4 counter drop comment "egress_local_dropped"';
const G2 = 'iifname "fcpi-egress" counter accept';
const J1 = "fib daddr type local counter jump DOCKER";
const J2 = "ip daddr 192.0.2.99 counter jump OTHER";
const chain = (table, name, hook, rules) => `table ${table} {
	chain ${name} {
		type filter hook ${hook}; policy accept;
${rules.map((r) => `\t\t${r}`).join("\n")}
	}
}
`;
const ruleset = ({ raw = [A, B, C], guard = [G1, G2], nat = [J1, J2], warn = false } = {}) => `${warn ? "# Warning: table ip filter is managed by iptables-nft, do not touch!\n" : ""}${chain("ip raw", "PREROUTING", "prerouting priority raw", raw)}${chain("ip nat", "PREROUTING", "prerouting priority dstnat", nat)}table inet fcpi_guard {
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
const canon = (input) => fingerprint(input).nft_ruleset_canonical_sha256;

test("re-ordering pure-match rules that share one verdict changes the raw hash and not the canonical one", () => {
  const base = fingerprint(ruleset());
  const swapped = fingerprint(ruleset({ raw: [C, A, B] }));
  assert.notEqual(base.nft_ruleset_sha256, swapped.nft_ruleset_sha256, "precondition: the raw hash does see the order");
  assert.equal(base.nft_ruleset_canonical_sha256, swapped.nft_ruleset_canonical_sha256);
  assert.equal(base.guard_table_sha256, swapped.guard_table_sha256);
  assert.match(base.order_insensitive_chains, /^1 ip raw\/PREROUTING$/, "only the all-pure-drop chain is sorted");
});

test("the same holds for pure-match accept rules, IPv6 addresses, ct state, and comments that mention braces or the word drop", () => {
  const rules = ['oifname "docker0" ct state related,established counter accept', 'ip6 saddr fd00::1/64 iifname "lo" counter accept',
    'udp dport 41641 counter accept', 'ip saddr 192.0.2.9 counter accept comment "drop { not a rule }"'];
  const a = fingerprint(chain("ip6 filter", "ts-input", "input priority filter", rules));
  const b = fingerprint(chain("ip6 filter", "ts-input", "input priority filter", [...rules].reverse()));
  assert.notEqual(a.nft_ruleset_sha256, b.nft_ruleset_sha256);
  assert.equal(a.nft_ruleset_canonical_sha256, b.nft_ruleset_canonical_sha256);
  assert.match(a.order_insensitive_chains, /^1 ip6 filter\/ts-input$/);
});

test("a real change in an all-pure-drop chain is still seen: an edited rule, a removed rule, an added rule", () => {
  const base = canon(ruleset());
  for (const [why, raw] of [
    ["a port edited", [A, B, C.replace("3380", "3381")]],
    ["an interface edited", [A, B.replace("br-b", "br-x"), C]],
    ["a rule removed", [A, B]],
    ["a rule added", [A, B, C, 'ip daddr 192.0.2.12 iifname != "br-c" counter drop']],
    ["a rule duplicated", [A, A, B, C]],
    ["a verdict flipped", [A, B, C.replace("drop", "accept")]],
  ]) assert.notEqual(canon(ruleset({ raw })), base, why);
});

test("a rule with a statement or a stateful match is never sorted: reordering it changes the canonical hash (each shape verified to change behaviour)", () => {
  // Every pair is two rules sharing a verdict, so a denylist of "continuing" words would have sorted them. Their order
  // decides which packets are mirrored, marked, metered or counted against a quota or a rate, so the order must be kept.
  const pairs = {
    "dup to (a mirror)": ['ip saddr 10.0.0.0/8 accept', 'ip saddr 10.0.0.5 dup to 192.0.2.66 device "eth0" accept'],
    "ct helper set": ['tcp dport 21 accept', 'tcp dport 21 ct helper set "ftp" accept'],
    "ip dscp set (a mangle)": ['tcp dport 80 ip dscp set cs2 accept', 'ip dscp set cs1 accept'],
    "update @set (a meter)": ['update @meter { ip saddr limit rate over 5/second } counter drop', 'tcp dport 22 counter drop'],
    "quota": ['ip saddr 192.0.2.5 drop', 'quota over 1 mbytes drop'],
    "limit": ['limit rate over 10/minute counter drop', 'tcp dport 22 counter drop'],
    "log": ['ip saddr 10.0.0.5 drop', 'ip saddr 10.0.0.6 log prefix "x" drop'],
    "ct count": ['ct count over 10 drop', 'tcp dport 22 drop'],
    "a named-set match": ['ip saddr @blocked counter drop', 'tcp dport 22 counter drop'],
  };
  for (const [why, [x, y]] of Object.entries(pairs)) {
    const a = fingerprint(chain("ip mangle", "PRE", "prerouting priority mangle", [x, y]));
    const b = fingerprint(chain("ip mangle", "PRE", "prerouting priority mangle", [y, x]));
    assert.notEqual(a.nft_ruleset_canonical_sha256, b.nft_ruleset_canonical_sha256, why);
    assert.match(a.order_insensitive_chains, /^0/, `${why}: the chain is not listed as order-insensitive`);
  }
});

test("where verdicts differ the order decides the outcome, so it is kept; a jump continues evaluation, so it is kept", () => {
  const base = fingerprint(ruleset());
  const mixed = fingerprint(ruleset({ guard: [G2, G1] }));
  assert.notEqual(base.nft_ruleset_canonical_sha256, mixed.nft_ruleset_canonical_sha256);
  assert.notEqual(base.guard_table_sha256, mixed.guard_table_sha256, "the project's own table is hashed in its listed order");
  assert.doesNotMatch(base.order_insensitive_chains, /fcpi_guard/);
  const jumped = fingerprint(ruleset({ nat: [J2, J1] }));
  assert.notEqual(base.nft_ruleset_canonical_sha256, jumped.nft_ruleset_canonical_sha256);
  assert.doesNotMatch(base.order_insensitive_chains, /ip nat/);
});

test("input handling: warnings are not rules; CRLF and a missing trailing newline do not change the result; truncated or empty input is refused", () => {
  const text = ruleset();
  assert.equal(fingerprint(ruleset({ warn: true })).nft_ruleset_sha256, fingerprint(text).nft_ruleset_sha256);
  const crlf = fingerprint(text.replace(/\n/g, "\r\n"));
  assert.equal(crlf.nft_ruleset_canonical_sha256, fingerprint(text).nft_ruleset_canonical_sha256);
  assert.notEqual(crlf.guard_table_sha256, "ABSENT", "the guard table is found in CRLF text");
  const noNewline = fingerprint(text.replace(/\n$/, ""));
  assert.equal(noNewline.guard_table_sha256, fingerprint(text).guard_table_sha256, "a missing trailing newline does not lose the guard table");
  assert.equal(noNewline.nft_ruleset_sha256, fingerprint(text).nft_ruleset_sha256);
  const empty = run("");
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /no ruleset/);
  const truncated = run(text.slice(0, text.lastIndexOf("}")));
  assert.equal(truncated.status, 2, "a listing cut off before its last brace is not hashed as if it were whole");
  assert.match(truncated.stderr, /unbalanced braces/);
});

test("--canonical prints the text with the order-insensitive chain sorted, for diffing two states", () => {
  const a = run(ruleset({ raw: [A, B, C] }), "--canonical").stdout;
  const b = run(ruleset({ raw: [C, B, A] }), "--canonical").stdout;
  assert.equal(a, b);
  const rules = a.split("\n").filter((l) => /counter drop$/.test(l) && l.includes("192.0.2.1"));
  assert.deepEqual(rules, [...rules].sort(), "the three drop rules appear in sorted order");
});
