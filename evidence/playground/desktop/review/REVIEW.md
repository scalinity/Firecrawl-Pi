## Code Review: Tauri desktop wrapper

### Summary
Reviewed `dd53fc3...0fe74d3` with two independent specialists, DB1 (debugger) and CA1 (code auditor), both GPT-6.1-Sol xhigh as a substitution for unavailable Opus 5.5. One critical regression, three warnings and one suggestion require remediation.

**Scope:**

- Full new source/configuration/tests: `desktop/src-tauri/src/main.rs`, `build.rs`, `Cargo.toml`, `tauri.conf.json`, `desktop/package.json`, `desktop/frontend/index.html`, `scripts/playground/desktop-server.mjs`, `tests/playground-desktop.test.mjs`.
- Changed lines, enclosing functions and integration: `LLM-DEMO.html`, `.gitignore`, `desktop/README.md`, `scripts/playground/README.md`.
- Tier 3: generated lockfiles and supplied/generated icons acknowledged, not reviewed line by line. The large-change threshold is dominated by generated dependency locks.
- Native compilation, tests and UI operation were NOT_RUN by the read-only reviewers. Separate app/backend review: `evidence/playground/app-review/REVIEW.md`.

### 🔴 Critical Issues (Must Fix)

1. **T1: Save JSON is cancelled on macOS** - `desktop/src-tauri/src/main.rs:138` _(corroborated: both agents)_
   - Problem: No native download handler is registered. The existing Save handler creates a Blob download.
   - Risk: Successful result → Save → WebKit download action → Wry sees no handler → cancellation with no saved file. Independently flagged by both reviewers.
   - Fix: Accept only Blob downloads belonging to the owned origin:
     ```rust
     let download_origin = origin.clone();
     // On the window builder:
     .on_download(move |_, event| match event {
         tauri::webview::DownloadEvent::Requested { url, .. } =>
             url.scheme() == "blob" && url.origin() == download_origin,
         tauri::webview::DownloadEvent::Finished { .. } => true,
         _ => false,
     })
     ```

### 🟡 Warnings (Should Fix)

1. **T2: External-browser launcher is not reaped** - `desktop/src-tauri/src/main.rs:108` _(unique to DB1's lane)_
   - Problem: The Child returned by spawning `open` is dropped without waiting.
   - Suggestion: Reap it in a waiting thread without blocking the UI.
2. **T3: Native ownership, controls and permissions lack coverage** - `tests/playground-desktop.test.mjs:14` _(corroborated: both agents)_
   - Problem: Node tests do not exercise readiness validation, native commands, foreign-origin IPC refusal, startup failure, forced shutdown, window close or application quit.
   - Suggestion: Add focused tests and actual native smoke checks. Include Copy, Save, source links, dragging, controls and child cleanup. Keep native checks distinct from HTTP fixture checks.
3. **T4: Shutdown test can run before its partial request connects** - `tests/playground-desktop.test.mjs:44` _(unique to CA1's lane)_
   - Problem: The test closes parent stdin immediately after asynchronous writes, without proving the socket connected or the partial write completed.
   - Suggestion: Synchronize the established request, then assert bounded connection termination.

### 🔵 Suggestions (Consider)

1. **T5: Preserve bounded startup diagnostics** - `desktop/src-tauri/src/main.rs:31` _(unique to CA1's lane)_
   - Current: Backend stderr is discarded, losing the reason for missing modules, incompatible Node or invalid SSH configuration.
   - Better: Report bounded, sanitized startup diagnostics without credentials or request contents.

### ✅ Good Practices

- Native commands are limited to four window operations on the owned loopback origin.
- Readiness URLs reject foreign hosts, credentials, queries, fragments and unexpected paths.
- Explicit resource mapping avoids bundling the repository or credentials.
- Backend ownership uses stdin EOF, bounded shutdown and child reaping.

### Verdict

[x] ❌ Request Changes (critical issues)
[ ] ⚠️ Approve with Suggestions
[ ] ✅ Approve

### Remediation outcomes

Pending /address. Native compilation remains held until all requested review findings are addressed.
