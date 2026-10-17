#!/usr/bin/env python3
"""A fingerprint of the Pi's nftables ruleset that does not move when Docker re-orders its own equivalent rules.

    ssh <pi> 'sudo -n nft -s list ruleset' | python3 -I scripts/host/firewall-fingerprint.py [--canonical]
    (or on the Pi itself: scripts/host/pi-firewall.sh)

The raw hash a host snapshot records (nft -s list ruleset | sha256sum) fingerprints the ruleset's text, and Docker adds
a container's rules when the container starts, so recreating containers re-orders the "drop direct access" rules in
table ip raw without changing what any packet meets (observed 2026-10-17: recreating the retrieval service alone and then
with the access gateway flipped the raw hash back and forth between two values, a difference of two lines).

This prints a second hash in which the rules of a chain are sorted only when every rule of the chain has exactly one
shape: pure matches, an optional counter, one terminal verdict (drop or accept) shared by the whole chain, and an optional
comment. A packet meets every rule of such a chain and the first match decides nothing that another rule would decide
differently, so the order cannot change any packet's outcome. A rule with any other statement (dup, a set or mangle
statement, a set update, log, a jump) or a stateful match (limit, quota, ct count) is not that shape, so its chain keeps its
order, and so does every set and the project's inet fcpi_guard table. The shape is an allowlist on purpose: a denylist of
"dangerous" words cannot be complete. An unknown rule keeps the chain ordered, which can only cost a false alarm.

Output, one key=value per line:
  nft_ruleset_sha256            the raw hash, as a snapshot records it
  nft_ruleset_canonical_sha256  the hash with those chains sorted
  order_insensitive_chains      how many chains were sorted, then their names
  guard_table_sha256            the project's own table (inet fcpi_guard) alone, in its listed order
--canonical prints the canonical text instead, for diffing two states. Exit 2 on empty or unbalanced input.
"""
import hashlib
import re
import sys

CHAIN = re.compile(r"^(\s*)chain (\S+) \{\s*$")
TABLE = re.compile(r"^table (\S+) (\S+) \{\s*$")
HEADER = re.compile(r"^\s*type \S+ hook ")
# The one shape whose order cannot matter: pure matches, an optional counter, a verdict, an optional comment.
ADDR = r"[0-9A-Fa-f:.]+(?:/\d{1,3})?"
MATCH = (rf"(?:ip6? [sd]addr (?:!= )?{ADDR}"
         r"|[io]ifname (?:!= )?\"[^\"]+\""
         r"|(?:tcp|udp) [sd]port (?:!= )?\d{1,5}"
         r"|ct state [a-z,]+)")
RULE = re.compile(rf"^\s*(?:{MATCH} )+(?:counter )?(drop|accept)(?: comment \"[^\"]*\")?\s*$")


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
        while j < len(lines) and lines[j].rstrip() != indent + "}":
            body.append(lines[j])
            j += 1
        head = [b for b in body if HEADER.match(b)]
        rules = [b for b in body if b not in head]
        shapes = [RULE.match(r) for r in rules]
        if rules and all(shapes) and len({s.group(1) for s in shapes}) == 1:
            rules = sorted(rules)
            sorted_chains.append(f"{table}/{name}")
        out.append(line)
        out.extend(head + rules)
        if j < len(lines):
            out.append(lines[j])
        i = j + 1
    return "\n".join(out) + "\n", sorted_chains


def balanced(text):
    """Braces outside quoted strings must pair up; a truncated listing would otherwise be hashed as if it were whole."""
    depth = 0
    for line in text.splitlines():
        for ch in re.sub(r'"[^"]*"', "", line):
            depth += (ch == "{") - (ch == "}")
            if depth < 0:
                return False
    return depth == 0


def guard_table(text):
    m = re.search(r"^table inet fcpi_guard \{\n.*?^\}\n", text, re.S | re.M)
    return m.group(0) if m else ""


def main(argv):
    # nft prints warnings about iptables-managed tables on stderr; if they were merged into the text they are not rules.
    text = "".join(l for l in sys.stdin if not l.startswith("# Warning"))
    if not text.strip():
        print("no ruleset on stdin", file=sys.stderr)
        return 2
    raw = text if text.endswith("\n") else text + "\n"
    norm = raw.replace("\r\n", "\n")
    if not balanced(norm):
        print("unbalanced braces: the input is truncated or is not an nft ruleset", file=sys.stderr)
        return 2
    canonical, chains = canonicalize(norm)
    if "--canonical" in argv:
        sys.stdout.write(canonical)
        return 0
    sha = lambda s: hashlib.sha256(s.encode()).hexdigest()
    guard = guard_table(norm)
    print(f"nft_ruleset_sha256={sha(raw)}")
    print(f"nft_ruleset_canonical_sha256={sha(canonical)}")
    print(f"order_insensitive_chains={len(chains)} {','.join(chains)}")
    print(f"guard_table_sha256={sha(guard) if guard else 'ABSENT'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
