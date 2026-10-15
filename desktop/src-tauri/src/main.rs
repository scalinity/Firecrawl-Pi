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
struct BackendOrigin(String);

fn validate_export(json: &str) -> Result<(), String> {
    if json.len() > 9 * 1024 * 1024 {
        return Err("The JSON result is too large to save.".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|_| "The result is not valid JSON.".to_string())?;
    if !value.is_object() {
        return Err("The result must be a JSON object.".into());
    }
    Ok(())
}

#[tauri::command]
async fn save_result(window: tauri::WebviewWindow, json: String) -> Result<bool, String> {
    let origin = window.state::<BackendOrigin>();
    let url = window
        .url()
        .map_err(|_| "The playground URL is unavailable.".to_string())?;
    if window.label() != "main" || !allows_navigation(&url, &origin.0) {
        return Err("Saving is only available in the playground window.".into());
    }
    validate_export(&json)?;
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_file_name("fcpi-result.json")
        .add_filter("JSON result", &["json"])
        .save_file()
        .await
    else {
        return Ok(false);
    };
    file.write(json.as_bytes())
        .await
        .map_err(|_| "The selected file could not be written.".to_string())?;
    Ok(true)
}

impl Backend {
    fn start(script: PathBuf) -> Result<(Self, Url), Box<dyn std::error::Error>> {
        Self::start_with_timeout(script, Duration::from_secs(15))
    }

    fn start_with_timeout(
        script: PathBuf,
        timeout: Duration,
    ) -> Result<(Self, Url), Box<dyn std::error::Error>> {
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
        let line = match rx.recv_timeout(timeout) {
            Ok(Ok(line)) if !line.is_empty() => line,
            other => {
                let timed_out = matches!(other, Err(mpsc::RecvTimeoutError::Timeout));
                backend.stop();
                let bytes = diagnostics_rx
                    .recv_timeout(Duration::from_millis(250))
                    .unwrap_or_default();
                let detail = startup_diagnostic(&bytes);
                return Err(io::Error::other(if timed_out {
                    format!(
                        "The local backend did not become ready within {} seconds. {detail}",
                        timeout.as_secs_f64()
                    )
                } else {
                    format!("The local backend exited before becoming ready. {detail}")
                })
                .into());
            }
        };
        let url = readiness_url(&line)?;
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
    if allows_source(url) {
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

fn readiness_url(line: &str) -> Result<Url, Box<dyn std::error::Error>> {
    let ready: serde_json::Value = serde_json::from_str(line)?;
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
    Ok(url)
}

fn allows_navigation(url: &Url, origin: &str) -> bool {
    url.origin().ascii_serialization() == origin && matches!(url.path(), "/" | "/LLM-DEMO.html")
}

fn allows_source(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
}

fn main() {
    let result = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![save_result])
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
                let origin = url.origin().ascii_serialization();
                app.manage(BackendOrigin(origin.clone()));
                app.add_capability(
                    CapabilityBuilder::new("playground-window")
                        .window("main")
                        .local(false)
                        .remote(format!("{}/*", origin))
                        .permission("core:window:allow-close")
                        .permission("core:window:allow-minimize")
                        .permission("core:window:allow-toggle-maximize")
                        .permission("core:window:allow-start-dragging")
                        .permission("allow-save-result"),
                )?;
                app.manage(Mutex::new(backend));
                let window =
                    tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                        .title("Firecrawl Pi")
                        .inner_size(1180.0, 800.0)
                        .min_inner_size(760.0, 560.0)
                        .decorations(true)
                        .title_bar_style(tauri::TitleBarStyle::Overlay)
                        .hidden_title(true)
                        .background_color(tauri::webview::Color(12, 12, 12, 255))
                        .on_navigation(move |next| allows_navigation(next, &origin))
                        .on_new_window(|url, _| {
                            open_source(&url);
                            NewWindowResponse::Deny
                        })
                        .build()?;
                // Setup runs on the main thread; Tauri owns this NSWindow for its lifetime.
                // Keep its native rounded frame while the existing header owns the controls.
                let native = unsafe { &*(window.ns_window()? as *const objc2_app_kit::NSWindow) };
                for button in [
                    objc2_app_kit::NSWindowButton::CloseButton,
                    objc2_app_kit::NSWindowButton::MiniaturizeButton,
                    objc2_app_kit::NSWindowButton::ZoomButton,
                ] {
                    if let Some(button) = native.standardWindowButton(button) {
                        button.setHidden(true);
                    }
                }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

    struct Script(PathBuf);
    impl Script {
        fn new(code: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "fcpi-native-{}-{}.mjs",
                std::process::id(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::write(&path, code).unwrap();
            Self(path)
        }
    }
    impl Drop for Script {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    #[test]
    fn readiness_rejects_foreign_malformed_and_credentialed_urls() {
        let valid = "http://127.0.0.1:49152/LLM-DEMO.html";
        assert!(readiness_url(&serde_json::json!({"url":valid}).to_string()).is_ok());
        for url in [
            "http://localhost:49152/LLM-DEMO.html",
            "https://127.0.0.1:49152/LLM-DEMO.html",
            "http://127.0.0.1:0/LLM-DEMO.html",
            "http://127.0.0.1/LLM-DEMO.html",
            "http://name:password@127.0.0.1:49152/LLM-DEMO.html",
            "http://127.0.0.1:49152/other",
            "http://127.0.0.1:49152/LLM-DEMO.html?q=1",
            "http://127.0.0.1:49152/LLM-DEMO.html#part",
        ] {
            assert!(
                readiness_url(&serde_json::json!({"url":url}).to_string()).is_err(),
                "{url}"
            );
        }
        for raw in ["", "{}", "{bad", "{\"url\":3}"] {
            assert!(readiness_url(raw).is_err());
        }
    }

    #[test]
    fn native_url_boundaries_match_only_the_owned_origin() {
        let origin = "http://127.0.0.1:49152";
        for url in [
            "http://127.0.0.1:49152/",
            "http://127.0.0.1:49152/LLM-DEMO.html",
        ] {
            assert!(allows_navigation(&Url::parse(url).unwrap(), origin));
        }
        for url in [
            "http://127.0.0.1:49153/LLM-DEMO.html",
            "https://example.com/",
            "http://127.0.0.1:49152/api/run",
            "blob:http://127.0.0.1:49152/id",
        ] {
            assert!(!allows_navigation(&Url::parse(url).unwrap(), origin));
        }
        for url in ["https://example.com/source", "http://example.com/"] {
            assert!(allows_source(&Url::parse(url).unwrap()));
        }
        for url in [
            "file:///tmp/fixture",
            "javascript:alert(1)",
            "https://name:password@example.com/",
        ] {
            assert!(!allows_source(&Url::parse(url).unwrap()));
        }
    }

    #[test]
    fn export_rejects_invalid_non_object_and_oversized_json() {
        assert!(validate_export("{\"success\":true}").is_ok());
        for json in ["", "{bad", "null", "[]", "true"] {
            assert!(validate_export(json).is_err());
        }
        assert!(validate_export(&" ".repeat(9 * 1024 * 1024 + 1)).is_err());
    }

    #[test]
    fn startup_diagnostics_report_classes_without_echoing_private_text() {
        assert!(
            startup_diagnostic(b"ERR_MODULE_NOT_FOUND secret-fixture-value")
                .contains("MODULE_NOT_FOUND")
        );
        assert!(
            !startup_diagnostic(b"ERR_MODULE_NOT_FOUND secret-fixture-value")
                .contains("secret-fixture-value")
        );
        assert!(startup_diagnostic(b"FCPI_NODE_TOO_OLD").contains("22"));
        assert!(startup_diagnostic(b"SyntaxError").contains("SyntaxError"));
        assert!(startup_diagnostic(b"pi-target.conf: missing").contains("SSH"));
        assert!(startup_diagnostic(b"unknown secret-fixture-value").contains("recognized"));
    }

    #[test]
    fn startup_failure_preserves_a_safe_diagnostic() {
        let script =
            Script::new("console.error('FCPI_NODE_TOO_OLD private-fixture');process.exit(1);");
        let error = match Backend::start(script.0.clone()) {
            Ok(_) => panic!("unexpected startup"),
            Err(error) => error.to_string(),
        };
        assert!(error.contains("22 or newer"));
        assert!(!error.contains("private-fixture"));
    }

    #[test]
    fn backend_startup_deadline_is_bounded() {
        let script =
            Script::new("process.stdin.resume();process.stdin.on('end',()=>process.exit(0));");
        let start = Instant::now();
        let error = match Backend::start_with_timeout(script.0.clone(), Duration::from_millis(100))
        {
            Ok(_) => panic!("unexpected startup"),
            Err(error) => error.to_string(),
        };
        assert!(error.contains("did not become ready"));
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn backend_forces_and_reaps_a_child_that_ignores_parent_eof() {
        let script = Script::new("console.log(JSON.stringify({url:'http://127.0.0.1:49152/LLM-DEMO.html'}));process.stdin.resume();setInterval(()=>{},1000);");
        let (mut backend, _) = Backend::start(script.0.clone()).unwrap();
        let start = Instant::now();
        backend.stop();
        assert!(backend.0.try_wait().unwrap().is_some());
        assert!(start.elapsed() < Duration::from_secs(5));
    }
}
