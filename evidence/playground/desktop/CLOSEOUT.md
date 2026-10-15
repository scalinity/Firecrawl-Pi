# Local playground and macOS desktop verification

The local playground runs in a native macOS Tauri window with rounded corners, a supplied icon and a private loopback backend. Content formats Markdown; Markdown preserves source text. Window controls use 32-pixel square targets, centered SVG icons and 12-pixel top/right padding.

The app and desktop review findings have recorded outcomes in their respective REVIEW.md reports. The final package was built from `75df9bc`; its binary and asset hashes, executed checks and unrun native checks are recorded in `verification.json`. Review substitutions and original findings remain in the reports.

The package uses an existing local Apple Development identity so macOS can retain local-network attribution across rebuilds. No signing identity, credentials, private endpoint or scraped response is stored here. Native Save replaced a Blob-download approach after an observed WebKit hang. Actual Save, Cancel, Copy, close, quit, formatted retrieval and window appearance were checked; external-link launch, foreign-origin IPC enforcement and final drag/minimize geometry remain unverified as listed in the receipt.

`ORCHESTRATION.html` needed no change: the milestone sequence, eligibility and file ownership it describes did not change. No Pi deployment or host requalification was performed. Existing unrelated untracked files were preserved.
