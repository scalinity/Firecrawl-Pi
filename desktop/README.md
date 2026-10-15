# Firecrawl Pi desktop

A macOS Tauri window for the existing local playground. The native title bar is
removed. Drag empty space in the existing header to move the window; double-click
it to maximize or restore. The header buttons minimize, maximize/restore, and close.
Closing the window or quitting the application stops its local backend. Durable
crawls remain on the Pi, as in the browser playground.

The icon comes from the supplied PNG in `icon-source.png`. Generated macOS icons
are in `src-tauri/icons/`; no third-party frontend code is bundled.

The app needs Node.js 22 or newer and the existing Pi SSH key/configuration.
It checks Homebrew's Apple Silicon and Intel Node locations, then PATH.
`FCPI_NODE` overrides that executable. Gateway credentials remain on the Pi.
The bundle contains only the explicit runtime file list in `tauri.conf.json`.
Each launch starts its own loopback server on an available port; it does not need
the separately running browser development server.

Install the pinned desktop CLI with `npm ci` in this directory. After explicit
authorization to compile, `npm run dev` launches Tauri development mode and
`npm run package` produces
`src-tauri/target/release/bundle/macos/Firecrawl Pi.app`.
These commands compile Rust. No frontend bundler or public service is involved.
The package is for local use; no signing identity, updater, or publication is configured.

From the repository root, the non-compiling runtime checks are:

```sh
node --test tests/playground-desktop.test.mjs tests/playground.test.mjs tests/playground-agent.test.mjs
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml --check
```

The runtime tests execute the exact resource map in an isolated temporary directory
and verify startup, loopback serving, cross-origin refusal, and shutdown while a
request is open. Native window appearance, dragging, controls, and Rust compilation
require a built application and are reported separately.
