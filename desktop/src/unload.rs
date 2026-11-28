//! Closing to the tray hides the window, but a hidden web view keeps all its memory. A few seconds
//! later (time for pending saves to finish) the window is destroyed; showing it again builds a new one.
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};

const AFTER: Duration = Duration::from_secs(5);
/// Bumped on every show and close, so a pending unload is dropped when the window comes back.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Call right after hiding the main window. `before` sees the window just before it goes.
pub fn later(app: &AppHandle, before: impl FnOnce(&WebviewWindow) + Send + 'static) {
    let mine = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(AFTER);
        let a = app.clone();
        let _ = app.run_on_main_thread(move || {
            if GENERATION.load(Ordering::SeqCst) != mine {
                return;
            }
            if let Some(w) = a.get_webview_window("main") {
                if !w.is_visible().unwrap_or(true) {
                    before(&w);
                    let _ = w.destroy();
                }
            }
        });
    });
}

/// Call before showing the window.
pub fn cancel() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}
