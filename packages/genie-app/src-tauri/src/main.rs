use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;

// ============================================================================
// Sidecar Bridge — proxies IPC between Tauri frontend and Bun backend
// ============================================================================

struct SidecarBridge {
    stdin: Mutex<Box<dyn Write + Send>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
}

impl SidecarBridge {
    fn request(&self, command: &str, params: Value) -> oneshot::Receiver<Result<Value, String>> {
        let (tx, rx) = oneshot::channel();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.pending.lock().unwrap().insert(id, tx);

        let msg = serde_json::json!({ "id": id, "command": command, "params": params });

        if let Ok(mut stdin) = self.stdin.lock() {
            let _ = writeln!(stdin, "{}", msg);
            let _ = stdin.flush();
        }

        rx
    }
}

// ============================================================================
// Tauri Command — generic proxy to sidecar
// ============================================================================

#[tauri::command]
async fn ipc_invoke(
    command: String,
    params: Option<Value>,
    bridge: tauri::State<'_, Arc<SidecarBridge>>,
) -> Result<Value, String> {
    let rx = bridge.request(&command, params.unwrap_or_else(|| serde_json::json!({})));
    rx.await.map_err(|_| "Sidecar disconnected".to_string())?
}

// ============================================================================
// App Entry
// ============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![ipc_invoke])
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Resolve backend entry point (dev: relative to Cargo manifest dir)
            let backend_entry = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("Cannot resolve package root")
                .join("src-backend")
                .join("index.ts");

            // Spawn the Bun sidecar process
            let mut child = Command::new("bun")
                .arg("run")
                .arg(&backend_entry)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .map_err(|e| format!("Failed to spawn Bun sidecar: {e}"))?;

            let stdin = child.stdin.take().expect("sidecar stdin");
            let stdout = child.stdout.take().expect("sidecar stdout");

            let bridge = Arc::new(SidecarBridge {
                stdin: Mutex::new(Box::new(stdin)),
                pending: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
            });

            let bridge_for_reader = bridge.clone();
            app.manage(bridge);
            app.manage(Mutex::new(Some(child)));

            // Background thread: read sidecar stdout, route responses and events
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    if line.trim().is_empty() {
                        continue;
                    }

                    let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                        // Non-JSON output (console.log from sidecar) → forward to stderr
                        eprintln!("[sidecar] {}", line);
                        continue;
                    };

                    match msg.get("type").and_then(|t| t.as_str()) {
                        Some("response") => {
                            let id = msg.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
                            if let Some(tx) = bridge_for_reader.pending.lock().unwrap().remove(&id) {
                                let error = msg
                                    .get("error")
                                    .and_then(|e| e.as_str())
                                    .filter(|s| !s.is_empty());
                                let result = match error {
                                    Some(err) => Err(err.to_string()),
                                    None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                                };
                                let _ = tx.send(result);
                            }
                        }
                        Some("event") => {
                            let event =
                                msg.get("event").and_then(|e| e.as_str()).unwrap_or("unknown");
                            let payload = msg.get("payload").cloned().unwrap_or(Value::Null);
                            let _ = app_handle.emit(event, payload);
                        }
                        _ => {
                            eprintln!("[sidecar] {}", line);
                        }
                    }
                }
                eprintln!("[tauri] Sidecar stdout reader exited");
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Run with cleanup on exit
    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(mut child) = app_handle
                .state::<Mutex<Option<Child>>>()
                .lock()
                .unwrap()
                .take()
            {
                let _ = child.kill();
            }
        }
    });
}
