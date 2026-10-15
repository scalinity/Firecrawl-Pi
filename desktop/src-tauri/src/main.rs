#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    io::{self, BufRead, BufReader, Read},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{ipc::CapabilityBuilder, webview::NewWindowResponse, Manager, Url, WebviewUrl};

struct Backend(Child);

impl Backend {
    fn start(script: PathBuf) -> Result<(Self, Url), Box<dyn std::error::Error>> {
        let candidates = match std::env::var_os("FCPI_NODE") {
            Some(node) => vec![node],
            None => vec![
                "/opt/homebrew/bin/node".into(),
                "/usr/local/bin/node".into(),
                "node".into(),
            ],
        };
        let mut launched = None;
        for node in candidates {
            match Command::new(node)
                .arg(&script)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
            {
                Ok(child) => {
                    launched = Some(child);
                    break;
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            }
        }
        let mut backend = Self(launched.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "Node.js was not found. Install Node.js 22 or newer.",
            )
        })?);
        let stdout = backend
            .0
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("Missing backend output"))?;
        let mut stderr = backend
            .0
            .stderr
            .take()
            .ok_or_else(|| io::Error::other("Missing backend diagnostics"))?;
        let (diagnostics_tx, diagnostics_rx) = mpsc::channel();
        thread::spawn(move || {
            let mut retained = Vec::new();
            let mut buffer = [0; 1024];
            while let Ok(count) = stderr.read(&mut buffer) {
                if count == 0 {
                    break;
                }
                let keep = count.min(4096 - retained.len());
                retained.extend_from_slice(&buffer[..keep]);
            }
            let _ = diagnostics_tx.send(retained);
        });
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout)
                .take(4096)
                .read_line(&mut line)
                .map(|_| line);
            let _ = tx.send(result);
        });
        let line = match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(Ok(line)) if !line.is_empty() => line,
            other => {
                let timed_out = matches!(other, Err(mpsc::RecvTimeoutError::Timeout));
                backend.stop();
                let bytes = diagnostics_rx
                    .recv_timeout(Duration::from_millis(250))
                    .unwrap_or_default();
                let detail = startup_diagnostic(&bytes);
                return Err(io::Error::other(if timed_out {
                    format!("The local backend did not become ready within 15 seconds. {detail}")
                } else {
                    format!("The local backend exited before becoming ready. {detail}")
                })
                .into());
            }
        };
        let ready: serde_json::Value = serde_json::from_str(&line)?;
        let url = Url::parse(
            ready["url"]
                .as_str()
                .ok_or_else(|| io::Error::other("Missing backend URL"))?,
        )?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.port().is_none_or(|port| port == 0)
            || url.path() != "/LLM-DEMO.html"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(io::Error::other("Invalid local backend URL").into());
        }
        Ok((backend, url))
    }

    fn stop(&mut self) {
        drop(self.0.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if matches!(self.0.try_wait(), Ok(Some(_))) {
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        self.stop();
    }
}

fn open_source(url: &Url) {
    if matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
    {
        if let Ok(mut child) = Command::new("/usr/bin/open").arg(url.as_str()).spawn() {
            thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
}

fn startup_diagnostic(bytes: &[u8]) -> &'static str {
    let text = String::from_utf8_lossy(bytes);
    if text.contains("FCPI_NODE_TOO_OLD") {
        "Install Node.js 22 or newer."
    } else if text.contains("ERR_MODULE_NOT_FOUND") || text.contains("MODULE_NOT_FOUND") {
        "Node reported MODULE_NOT_FOUND; a bundled runtime file is missing."
    } else if text.contains("SyntaxError") {
        "Node reported SyntaxError; check the Node version and bundled runtime."
    } else if text.contains("Invalid playground SSH configuration")
        || text.contains("pi-target.conf")
    {
        "The playground SSH configuration could not be loaded."
    } else {
        "Node did not report a recognized startup error."
    }
}

fn startup_failed(message: &str) {
    let detail: String = message
        .chars()
        .filter(|c| !c.is_control())
        .take(600)
        .collect();
    eprintln!("Firecrawl Pi could not start: {detail}");
    let _ = Command::new("/usr/bin/osascript").args(["-e",
        "on run argv\n display alert \"Firecrawl Pi could not start\" message (item 1 of argv) as critical\nend run",
        "--", &detail]).status();
}

fn main() {
    let result = tauri::Builder::default()
        .setup(|app| {
            let start = || -> Result<(), Box<dyn std::error::Error>> {
                let bundled = app
                    .path()
                    .resource_dir()?
                    .join("runtime/scripts/playground/desktop-server.mjs");
                let script = if cfg!(debug_assertions) && !bundled.is_file() {
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .join("../../scripts/playground/desktop-server.mjs")
                } else {
                    bundled
                };
                let (backend, url) = Backend::start(script)?;
                let origin = url.origin();
                let download_origin = origin.clone();
                app.add_capability(
                    CapabilityBuilder::new("playground-window")
                        .window("main")
                        .local(false)
                        .remote(format!("{}/*", url.origin().ascii_serialization()))
                        .permission("core:window:allow-close")
                        .permission("core:window:allow-minimize")
                        .permission("core:window:allow-toggle-maximize")
                        .permission("core:window:allow-start-dragging"),
                )?;
                app.manage(Mutex::new(backend));
                tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                    .title("Firecrawl Pi")
                    .inner_size(1180.0, 800.0)
                    .min_inner_size(760.0, 560.0)
                    .decorations(false)
                    .background_color(tauri::webview::Color(12, 12, 12, 255))
                    .on_download(move |_, event| match event {
                        tauri::webview::DownloadEvent::Requested { url, .. } => {
                            url.scheme() == "blob" && url.origin() == download_origin
                        }
                        tauri::webview::DownloadEvent::Finished { .. } => true,
                        _ => false,
                    })
                    .on_navigation(move |next| {
                        next.origin() == origin && matches!(next.path(), "/" | "/LLM-DEMO.html")
                    })
                    .on_new_window(|url, _| {
                        open_source(&url);
                        NewWindowResponse::Deny
                    })
                    .build()?;
                Ok(())
            };
            // Tauri runs setup after build(), so handle its errors here instead of panicking.
            if let Err(error) = start() {
                startup_failed(&error.to_string());
                app.handle().exit(1);
            }
            Ok(())
        })
        .build(tauri::generate_context!());
    match result {
        Ok(app) => app.run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(backend) = app.try_state::<Mutex<Backend>>() {
                    if let Ok(mut backend) = backend.lock() {
                        backend.stop();
                    }
                }
            }
        }),
        Err(error) => {
            startup_failed(&error.to_string());
            std::process::exit(1);
        }
    }
}
