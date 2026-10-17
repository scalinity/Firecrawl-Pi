# Firewall experiment, 2026-10-17 (the question left open in evidence/post-m9/anthropic-models/snapshot-attribution.json)

Question: why did the snapshot's `nft -s list ruleset` hash differ between an earlier session's BEFORE (e1e3a82a…) and AFTER (86344c11…), with no firewall command run?

Method: capture the full ruleset text around each step. The text holds the Pi's LAN addresses, so it is kept privately outside the repository; this file records hashes and a masked diff.

| capture | what it follows | raw hash (as snapshots record it) | canonical hash (order-insensitive where order cannot matter) | project guard table |
|---|---|---|---|---|
| R0 | before any change by this part of the session (a deploy of code and two image builds came next) | `86344c110bc1bfc5…` | `65b18fd52814078a…` | `f291c0cec99db9c3…` |
| R1 | after deploying code and building two images, before any container was recreated | `86344c110bc1bfc5…` | `65b18fd52814078a…` | `f291c0cec99db9c3…` |
| R2 | after recreating retrieval-service and access-gateway together | `e1e3a82a1d4d6b6d…` | `65b18fd52814078a…` | `f291c0cec99db9c3…` |
| R3 | before the next recreate (settled state after R2) | `e1e3a82a1d4d6b6d…` | `65b18fd52814078a…` | `f291c0cec99db9c3…` |
| R4 | after recreating retrieval-service alone | `86344c110bc1bfc5…` | `65b18fd52814078a…` | `f291c0cec99db9c3…` |

Order-insensitive chains (every rule is pure matches, an optional counter, one verdict shared by the whole chain, and an optional comment): `4 ip filter/DOCKER-CT,ip filter/DOCKER-INTERNAL,ip6 filter/ts-input,ip raw/PREROUTING`

## The whole difference between R1 and R2 (addresses masked)

```diff
--- R1
+++ R2
@@ -258,7 +258,7 @@
 	chain PREROUTING {
 		type filter hook prerouting priority raw; policy accept;
+		ip daddr <ip> iifname != "fcpi-egress" counter drop
 		ip daddr <ip> iifname != "fcpi-access" counter drop
 		ip daddr <ip> iifname != "lo" tcp dport 3380 counter drop
-		ip daddr <ip> iifname != "fcpi-egress" counter drop
-	}
-}
+	}
+}
```

## Reading
- R0 and R1 are byte-identical: deploying the code and building images does not touch the firewall.
- Recreating retrieval-service and access-gateway together moved the hash from `86344c11…` to `e1e3a82a…` (R2, stable as R3). Recreating retrieval-service alone moved it back to `86344c11…` (R4). `e1e3a82a…` is the value an earlier session's BEFORE snapshot showed.
- The difference is two lines: the order of three Docker-managed rules in `table ip raw`, `chain PREROUTING`, each `ip daddr <container> … counter drop`. Docker adds a container's rules when it starts, so the order follows the order containers were last created.
- All three rules end in `drop` and the chain's policy is accept. In a chain whose rules all share one terminal verdict, the order cannot change which packets are dropped, so the firewall's meaning is the same in both states.
- The canonical hash is identical across all five captures and the project's own `inet fcpi_guard` table hash is identical across all five; the raw hashes reproduce the values the snapshots recorded.
