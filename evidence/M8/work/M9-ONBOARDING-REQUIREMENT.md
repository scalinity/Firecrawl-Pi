# Owner requirement for M9 (given 2026-09-28 during M8): carry into M9's kickoff prompt at M8's close-out

Additional M9 requirement: global MCP client installation and desktop-client onboarding. An addition to M9's scope,
not a replacement; preserve every existing M9 acceptance requirement; do not weaken acceptance to force hosted clients green.

After the Pi MCP endpoint passes M9's MCP, security, reachability, restart and Cloud-independence checks:
1. Claude Code, user/global scope: discover the accepted endpoint, transport, auth and name (no placeholders); use the
   installed version's supported user-scoped mechanism, preferring `claude mcp add --scope user --transport http <name> <url>`
   after verifying syntax against `claude mcp add --help`; preserve every existing server and setting; never overwrite
   ~/.claude.json wholesale; auth via the supported method (headers/OAuth/bridge), no invented syntax; no long-lived secret
   in the repo; verify from an unrelated directory in a fresh session: server appears, tools discoverable, one real
   Firecrawl call reaches the Pi on the self-hosted backend, zero Cloud requests; record the effective config location and
   the exact command, credentials redacted.
2. Codex, global: current supported mechanism, preferring `codex mcp add <name> --url <url>` after checking the installed
   help; preserve every entry in ~/.codex/config.toml, no wholesale rewrite; actual URL/auth contract; credentials out of
   repo and evidence; verify from an unrelated directory in a fresh session: listing, tools, one real call reaching the
   Pi, zero Cloud calls; record the path and redacted entry.
3. Configuration presence is not verification: a real end-to-end Firecrawl request through each client, recorded as
   actual-client evidence separate from SDK protocol fixtures.
4. ChatGPT Developer Mode custom MCP/app: check current official OpenAI docs and the owner's plan capability; turn on or
   instruct Developer Mode via the current UI path; find the current creation surface (user settings, Plugins/Apps
   directory, workspace settings, ChatGPT Work, other); create it if permitted, else exact owner steps; actual URL
   (ending /mcp), transport, name, description, supported auth; import the real tool catalog; verify a real read/fetch
   Firecrawl call if reachable; record plan limits (Pro: read/fetch custom MCP in Developer Mode; full write may need
   Business/Enterprise/Edu; read/fetch suffices for Firecrawl; do not report custom MCP unavailable because write is
   restricted). Reachability: ChatGPT connects to a remote server, not a LAN/tailnet URL; prefer OpenAI Secure MCP Tunnel
   where supported, else the selected authenticated remote ingress; never expose the Pi unauthenticated, never bind the
   internal API publicly, no broad public ingress to make a checklist green; if a tunnel or route needs the owner's account
   action, give the exact minimal action and continue other work. Instructions distinguish: Developer Mode enabled; app
   creation; endpoint reachability; MCP auth; tool permission level on the plan; actual successful invocation.
5. Claude Desktop: check current Anthropic custom-connector docs; exact menu path, fields, enabling in a conversation;
   distinguish a remote custom connector (brokered through Anthropic's cloud, so a LAN/tailnet URL is not reachable) from
   a local Claude Desktop MCP configuration (may reach the Pi over the Mac's LAN/tailnet: document separately, never
   mislabel); if the private deployment needs approved authenticated ingress for Claude's cloud, give the exact owner action.
6. One accepted MCP implementation and endpoint; private and authenticated remote paths to it; no separate Firecrawl backend
   per client; internal services stay private. Target: Pi /mcp -> Claude Code global, Codex global, remote ingress ->
   ChatGPT Developer Mode and Claude custom connector.
7. Final M9 report section "MCP Client Onboarding": server name; URL; transport; auth type; private/tailnet-only or
   remotely reachable; Claude Code global status and live result; Codex global status and live result; ChatGPT Developer
   Mode status, exact current setup steps, plan permission level, reachability mechanism, live result if executable;
   Claude Desktop exact current steps, remote-connector reachability mechanism, local-vs-remote distinction, live result if
   executable; owner actions still required; each client path VERIFIED_LIVE, CONFIGURED_PENDING_OWNER_ACTION,
   SUPPORTED_NOT_CONFIGURED or UNSUPPORTED_CURRENTLY.
