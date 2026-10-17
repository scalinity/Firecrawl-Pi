#!/usr/bin/env python3
"""A fingerprint of the Pi's nftables ruleset that does not move when Docker re-orders its own equivalent rules.

    ssh <pi> 'sudo -n nft -s list ruleset' | python3 -I scripts/host/firewall-fingerprint.py [--canonical]

The raw hash a host snapshot records (nft -s list ruleset | sha256sum) fingerprints the ruleset's text, and Docker adds
a container's rules when the container starts, so recreating containers re-orders the "drop direct access" rules in
table ip raw without changing what any packet meets (observed 2026-10-17: recreating the retrieval service alone and then
with the access gateway flipped the raw hash back and forth between two values, a difference of two lines).

This reads that same text and prints a second hash in which the rules of a chain are sorted only where their order cannot
matter: a chain whose rules all end in the same verdict, drop or accept. A packet meets every rule of such a chain in some
order and the outcome is the same whichever comes first. Every other chain, and every set, keeps its order exactly, so a
real change (a rule added, removed or edited, or reordered where order decides the outcome) still changes the hash.

Output, one key=value per line:
  nft_ruleset_sha256            the raw hash, as a snapshot records it
  nft_ruleset_canonical_sha256  the hash with those chains sorted
  order_insensitive_chains      how many chains were sorted, then their names
  guard_table_sha256            the project's own table (inet fcpi_guard) alone, in its listed order
--canonical prints the canonical text instead, for diffing two states.
"""
import hashlib
import re
import sys

CHAIN = re.compile(r"^(\s*)chain (\S+) \{\s*$")
TABLE = re.compile(r"^table (\S+) (\S+) \{\s*$")
# A verdict that ends a rule; anything that continues evaluation (jump, goto, return, counter-only, log) is not one.
VERDICT = re.compile(r"\b(drop|accept)\s*(?:comment \"[^\"]*\")?\s*$")
CONTINUES = re.compile(r"\b(jump|goto|return|continue|log|queue|redirect|dnat|snat|masquerade|mark|ct mark|meta mark|notrack)\b")


def canonicalize(text):
    """Returns (canonical text, names of the chains sorted)."""
    lines = text.splitlines()
    out, sorted_chains, table = [], [], None
    i = 0
    while i < len(lines):
        line = lines[i]
        t = TABLE.match(line)
        if t:
            table = f"{t.group(1)} {t.group(2)}"
        c = CHAIN.match(line)
        if not c:
            out.append(line)
            i += 1
            continue
        indent, name = c.group(1), c.group(2)
        j = i + 1
        body = []
        while j < len(lines) and not re.match(rf"^{indent}\}}\s*$", lines[j]):
            body.append(lines[j])
            j += 1
        head = [b for b in body if re.match(r"^\s*type \S+ hook ", b)]
        rules = [b for b in body if b not in head]
        verdicts = {(VERDICT.search(r) or [None, None])[1] for r in rules}
        if rules and len(verdicts) == 1 and None not in verdicts and not any(CONTINUES.search(r) for r in rules):
            rules = sorted(rules)
            sorted_chains.append(f"{table}/{name}")
        out.append(line)
        out.extend(head + rules)
        if j < len(lines):
            out.append(lines[j])
        i = j + 1
    return "\n".join(out) + "\n", sorted_chains


def guard_table(text):
    m = re.search(r"^table inet fcpi_guard \{\n.*?^\}\n", text, re.S | re.M)
    return m.group(0) if m else ""


def main(argv):
    # nft prints warnings about iptables-managed tables on stderr; if they were merged into the text they are not rules.
    text = "".join(l for l in sys.stdin if not l.startswith("# Warning"))
    if not text.strip():
        print("no ruleset on stdin", file=sys.stderr)
        return 2
    canonical, chains = canonicalize(text)
    if "--canonical" in argv:
        sys.stdout.write(canonical)
        return 0
    sha = lambda s: hashlib.sha256(s.encode()).hexdigest()
    raw = text if text.endswith("\n") else text + "\n"
    print(f"nft_ruleset_sha256={sha(raw)}")
    print(f"nft_ruleset_canonical_sha256={sha(canonical)}")
    print(f"order_insensitive_chains={len(chains)} {','.join(chains)}")
    print(f"guard_table_sha256={sha(guard_table(text)) if guard_table(text) else 'ABSENT'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
