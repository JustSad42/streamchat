//! StreamChat desktop: a window around the StreamChat web app.
//!
//! "This PC" mode starts the bundled server (streamchat-server.exe) in the background, so the OBS
//! overlay keeps working while the window is hidden in the tray. "Server" mode just opens a
//! StreamChat server running elsewhere (e.g. on a Hetzner box over Tailscale).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, State, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const REPO: &str = "JustSad42/streamchat";
static POPOUTS: AtomicU32 = AtomicU32::new(0);

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct Config {
    /// "local" (run the server on this PC) or "remote" (connect to a server elsewhere)
    mode: String,
    remote_url: String,
    remote_key: String,
    port: u16,
    webhook_port: u16,
    access_key: String,
    close_to_tray: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            mode: "local".into(),
            remote_url: String::new(),
            remote_key: String::new(),
            port: 8787,
            webhook_port: 8788,
            access_key: String::new(),
            close_to_tray: true,
        }
    }
}

#[derive(Clone, Serialize)]
struct UpdateInfo {
    version: String,
    installer_url: String,
    sha256_url: String,
}

struct AppState {
    cfg: Arc<Mutex<Config>>,
    child: Mutex<Option<Child>>,
    data_dir: PathBuf,
    quitting: Mutex<bool>,
    update: Arc<Mutex<Option<UpdateInfo>>>,
}

fn random_key() -> String {
    use rand::Rng;
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    let mut rng = rand::thread_rng();
    (0..28).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect()
}

fn load_config(dir: &PathBuf) -> Config {
    let mut cfg: Config = fs::read_to_string(dir.join("desktop.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if cfg.access_key.is_empty() {
        cfg.access_key = random_key();
        save_config(dir, &cfg);
    }
    cfg
}

fn save_config(dir: &PathBuf, cfg: &Config) {
    let _ = fs::create_dir_all(dir);
    let _ = fs::write(dir.join("desktop.json"), serde_json::to_string_pretty(cfg).unwrap_or_default());
}

/// Where the bundled server and web files are: next to the exe when installed,
/// or in the source tree during development.
fn resources() -> (PathBuf, PathBuf) {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())).unwrap_or_default();
    let installed = (exe_dir.join("streamchat-server.exe"), exe_dir.join("web"));
    if installed.0.exists() {
        return installed;
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    (root.join("server").join("dist").join("streamchat-server.exe"), root.join("web"))
}

fn healthy(base: &str, timeout: Duration) -> bool {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .build()
        .into();
    match agent.get(&format!("{base}/health")).call() {
        Ok(mut r) => r.body_mut().read_to_string().map(|b| b.contains("\"ok\":true")).unwrap_or(false),
        Err(_) => false,
    }
}

fn log_tail(dir: &PathBuf) -> String {
    let text = fs::read_to_string(dir.join("server.log")).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(6)..].join("\n")
}

fn start_local(state: &AppState) -> Result<String, String> {
    let cfg = state.cfg.lock().unwrap().clone();
    let base = format!("http://127.0.0.1:{}", cfg.port);
    let app_url = format!("{base}/app?key={}", cfg.access_key);

    let mut child_slot = state.child.lock().unwrap();
    if let Some(child) = child_slot.as_mut() {
        if child.try_wait().map(|s| s.is_none()).unwrap_or(false) && healthy(&base, Duration::from_secs(2)) {
            return Ok(app_url);
        }
        let _ = child.kill();
        *child_slot = None;
    }
    if healthy(&base, Duration::from_millis(800)) {
        return Err(format!(
            "Something else is already using port {}. Close the other StreamChat (or change the port in desktop.json) and try again.",
            cfg.port
        ));
    }

    let (server, web) = resources();
    if !server.exists() {
        return Err(format!("The StreamChat server is missing ({}). Reinstall StreamChat.", server.display()));
    }
    let data = state.data_dir.join("data");
    let _ = fs::create_dir_all(&data);
    let log = fs::File::create(state.data_dir.join("server.log")).map_err(|e| e.to_string())?;
    let child = Command::new(&server)
        .env("STREAMCHAT_DATA", &data)
        .env("STREAMCHAT_WEB", &web)
        .env("STREAMCHAT_ACCESS_KEY", &cfg.access_key)
        .env("STREAMCHAT_PARENT_PID", std::process::id().to_string())
        .env("STREAMCHAT_QUIET_KEY", "1")
        .env("PORT", cfg.port.to_string())
        .env("WEBHOOK_PORT", cfg.webhook_port.to_string())
        .env("HOST", "127.0.0.1")
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Couldn't start the StreamChat server: {e}"))?;
    *child_slot = Some(child);

    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(20) {
        if let Some(c) = child_slot.as_mut() {
            if let Ok(Some(status)) = c.try_wait() {
                *child_slot = None;
                return Err(format!("The server stopped ({status}).\n{}", log_tail(&state.data_dir)));
            }
        }
        if healthy(&base, Duration::from_secs(1)) {
            return Ok(app_url);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!("The server didn't start in time.\n{}", log_tail(&state.data_dir)))
}

fn normalize_url(u: &str) -> String {
    let u = u.trim().trim_end_matches('/');
    if u.starts_with("http://") || u.starts_with("https://") { u.to_string() } else { format!("http://{u}") }
}

fn stop_local(state: &AppState) {
    if let Some(mut c) = state.child.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

// ---------------- updates (GitHub releases) ----------------

fn newer(a: &str, b: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> { v.trim_start_matches('v').split(['.', '-']).take(3).map(|x| x.parse().unwrap_or(0)).collect() };
    let (pa, pb) = (parse(a), parse(b));
    for i in 0..3 {
        let (x, y) = (pa.get(i).copied().unwrap_or(0), pb.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(timeout)).build().into()
}

fn check_update() -> Option<UpdateInfo> {
    let mut r = agent(Duration::from_secs(20))
        .get(&format!("https://api.github.com/repos/{REPO}/releases/latest"))
        .header("User-Agent", "StreamChat-desktop")
        .header("Accept", "application/vnd.github+json")
        .call()
        .ok()?;
    let j: serde_json::Value = serde_json::from_str(&r.body_mut().read_to_string().ok()?).ok()?;
    let tag = j["tag_name"].as_str()?.trim_start_matches('v').to_string();
    if !newer(&tag, env!("CARGO_PKG_VERSION")) {
        return None;
    }
    let assets = j["assets"].as_array()?;
    let find = |suffix: &str| {
        assets.iter().find_map(|a| {
            let name = a["name"].as_str()?;
            if name.ends_with(suffix) { a["browser_download_url"].as_str().map(String::from) } else { None }
        })
    };
    Some(UpdateInfo { version: tag, installer_url: find("-setup.exe")?, sha256_url: find("-setup.exe.sha256")? })
}

/// Tell the page about an available update (it shows a banner with "Update now").
fn announce_update(app: &AppHandle) {
    let info = app.state::<AppState>().update.lock().unwrap().clone();
    if let (Some(info), Some(w)) = (info, app.get_webview_window("main")) {
        let js = format!(
            "window.__streamchatUpdate={{version:{v}}};window.dispatchEvent(new CustomEvent('streamchat-update',{{detail:window.__streamchatUpdate}}));",
            v = serde_json::to_string(&info.version).unwrap_or_default()
        );
        let _ = w.eval(&js);
        if let Some(tray) = app.tray_by_id("tray") {
            let _ = tray.set_tooltip(Some(&format!("StreamChat (update {} available)", info.version)));
        }
    }
}

fn start_update_checks(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(25));
        loop {
            if let Some(info) = check_update() {
                *app.state::<AppState>().update.lock().unwrap() = Some(info);
                announce_update(&app);
            }
            std::thread::sleep(Duration::from_secs(6 * 3600));
        }
    });
}

#[tauri::command]
fn update_info(state: State<'_, AppState>) -> Option<UpdateInfo> {
    state.update.lock().unwrap().clone()
}

/// Download the new installer, check its SHA-256, run it silently and quit (it restarts StreamChat).
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    let info = app.state::<AppState>().update.lock().unwrap().clone().or_else(check_update).ok_or("You already have the newest version.")?;
    let expected = agent(Duration::from_secs(30))
        .get(&info.sha256_url)
        .header("User-Agent", "StreamChat-desktop")
        .call()
        .map_err(|e| format!("Couldn't download the update: {e}"))?
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let expected = expected.split_whitespace().next().unwrap_or("").to_lowercase();
    let mut resp = agent(Duration::from_secs(600))
        .get(&info.installer_url)
        .header("User-Agent", "StreamChat-desktop")
        .call()
        .map_err(|e| format!("Couldn't download the update: {e}"))?;
    let path = std::env::temp_dir().join(format!("StreamChat-{}-setup.exe", info.version));
    let mut file = fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut reader = resp.body_mut().as_reader();
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Download failed: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    drop(file);
    let got: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if got != expected {
        let _ = fs::remove_file(&path);
        return Err("The downloaded update didn't match its checksum, so it wasn't installed. Try again later.".into());
    }
    Command::new(&path)
        .args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"])
        .spawn()
        .map_err(|e| format!("Couldn't start the installer: {e}"))?;
    *app.state::<AppState>().quitting.lock().unwrap() = true;
    stop_local(&app.state::<AppState>());
    app.exit(0);
    Ok(())
}

// ---------------- commands for the launcher page ----------------

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> Config {
    let mut c = state.cfg.lock().unwrap().clone();
    c.access_key = String::new();
    c
}

#[tauri::command]
fn save_connection(state: State<'_, AppState>, mode: String, remote_url: String, remote_key: String) -> Result<(), String> {
    let mut cfg = state.cfg.lock().unwrap();
    if mode == "remote" && remote_url.trim().is_empty() {
        return Err("Enter your server's address.".into());
    }
    cfg.mode = if mode == "remote" { "remote".into() } else { "local".into() };
    cfg.remote_url = if remote_url.trim().is_empty() { String::new() } else { normalize_url(&remote_url) };
    cfg.remote_key = remote_key.trim().to_string();
    save_config(&state.data_dir, &cfg);
    Ok(())
}

#[tauri::command]
async fn start(state: State<'_, AppState>) -> Result<String, String> {
    let cfg = state.cfg.lock().unwrap().clone();
    if cfg.mode == "remote" {
        stop_local(&state);
        let base = normalize_url(&cfg.remote_url);
        if !healthy(&base, Duration::from_secs(6)) {
            return Err(format!("Couldn't reach {base}. Is the server running, and is Tailscale connected on this PC?"));
        }
        let key = urlencode(&cfg.remote_key);
        return Ok(if key.is_empty() { format!("{base}/app") } else { format!("{base}/app?key={key}") });
    }
    start_local(&state)
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

// ---------------- window / tray ----------------

fn launcher_url(setup: bool) -> WebviewUrl {
    WebviewUrl::App(if setup { "index.html?setup=1".into() } else { "index.html".into() })
}

fn is_allowed(url: &Url, cfg: &Config) -> bool {
    match url.scheme() {
        "tauri" | "about" | "data" | "blob" => return true,
        _ => {}
    }
    let host = url.host_str().unwrap_or("");
    if host == "tauri.localhost" || host == "127.0.0.1" || host == "localhost" {
        return true;
    }
    if !cfg.remote_url.is_empty() {
        if let Ok(r) = Url::parse(&cfg.remote_url) {
            if r.host_str() == Some(host) {
                return true;
            }
        }
    }
    false
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn open_launcher(app: &AppHandle, setup: bool) {
    if let Some(w) = app.get_webview_window("main") {
        if let WebviewUrl::App(p) = launcher_url(setup) {
            // On Windows, Tauri serves the bundled pages from http://tauri.localhost.
            if let Ok(u) = Url::parse(&format!("http://tauri.localhost/{}", p.display())) {
                let _ = w.navigate(u);
            }
        }
    }
    show_main(app);
}

fn build_window(app: &AppHandle) -> tauri::Result<()> {
    let cfg_nav = app.state::<AppState>().cfg.clone();
    let cfg_win = app.state::<AppState>().cfg.clone();
    let app_win = app.clone();
    WebviewWindowBuilder::new(app, "main", launcher_url(false))
        .title("StreamChat")
        .inner_size(520.0, 820.0)
        .min_inner_size(360.0, 420.0)
        .on_navigation(move |url| {
            let cfg = cfg_nav.lock().unwrap().clone();
            if is_allowed(url, &cfg) {
                true
            } else {
                let _ = open::that_detached(url.as_str());
                false
            }
        })
        .on_new_window(move |url, _features| {
            let cfg = cfg_win.lock().unwrap().clone();
            if is_allowed(&url, &cfg) && url.query_pairs().any(|(k, v)| k == "popout" && v == "1") {
                // A chat pop-out: its own small StreamChat window that stays on top of the game.
                let app = app_win.clone();
                let u = url.clone();
                tauri::async_runtime::spawn(async move { let _ = open_popout(&app, u); });
            } else {
                // Links and sign-in pages open in the normal browser.
                let _ = open::that_detached(url.as_str());
            }
            NewWindowResponse::Deny
        })
        .on_page_load(|w, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                announce_update(w.app_handle());
            }
        })
        .build()?;
    Ok(())
}

fn open_popout(app: &AppHandle, url: Url) -> tauri::Result<()> {
    let n = POPOUTS.fetch_add(1, Ordering::SeqCst);
    let title = url
        .query_pairs()
        .find(|(k, _)| k == "view")
        .map(|(_, v)| {
            let v = v.to_string();
            let mut c = v.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or(v)
        })
        .unwrap_or_else(|| "Chat".into());
    let cfg_nav = app.state::<AppState>().cfg.clone();
    WebviewWindowBuilder::new(app, format!("popout-{n}"), WebviewUrl::External(url))
        .title(format!("{title} · StreamChat"))
        .inner_size(420.0, 760.0)
        .min_inner_size(260.0, 300.0)
        .always_on_top(true)
        .on_navigation(move |u| {
            let cfg = cfg_nav.lock().unwrap().clone();
            if is_allowed(u, &cfg) { true } else { let _ = open::that_detached(u.as_str()); false }
        })
        .on_new_window(|u, _| { let _ = open::that_detached(u.as_str()); NewWindowResponse::Deny })
        .build()?;
    Ok(())
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open_i = MenuItem::with_id(app, "open", "Open StreamChat", true, None::<&str>)?;
    let conn_i = MenuItem::with_id(app, "connection", "Change connection…", true, None::<&str>)?;
    let upd_i = MenuItem::with_id(app, "update", "Check for updates", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit StreamChat", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_i, &conn_i, &upd_i, &PredefinedMenuItem::separator(app)?, &quit_i])?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id("tray")
        .icon(icon)
        .tooltip("StreamChat")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "open" => show_main(app),
            "connection" => open_launcher(app, true),
            "update" => {
                if let Some(w) = app.get_webview_window("main") {
                    if let Ok(u) = Url::parse("http://tauri.localhost/index.html?update=1") {
                        let _ = w.navigate(u);
                    }
                }
                show_main(app);
            }
            "quit" => {
                *app.state::<AppState>().quitting.lock().unwrap() = true;
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app)))
        .invoke_handler(tauri::generate_handler![get_config, save_connection, start, update_info, install_update])
        .setup(|app| {
            // STREAMCHAT_DESKTOP_DATA lets a test copy use its own folder instead of the real one.
            let data_dir = match std::env::var_os("STREAMCHAT_DESKTOP_DATA") {
                Some(d) => PathBuf::from(d),
                None => app.path().app_data_dir()?,
            };
            let cfg = load_config(&data_dir);
            app.manage(AppState { cfg: Arc::new(Mutex::new(cfg)), child: Mutex::new(None), data_dir, quitting: Mutex::new(false), update: Arc::new(Mutex::new(None)) });
            build_tray(app)?;
            build_window(app.handle())?;
            if std::env::var_os("STREAMCHAT_NO_UPDATE_CHECK").is_none() {
                start_update_checks(app.handle().clone());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return; // pop-outs just close
                }
                let app = window.app_handle();
                let state = app.state::<AppState>();
                let cfg = state.cfg.lock().unwrap().clone();
                // In "This PC" mode the overlay needs the server, so keep running in the tray.
                if cfg.mode == "local" && cfg.close_to_tray && !*state.quitting.lock().unwrap() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building StreamChat")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_local(&app.state::<AppState>());
            }
        });
}
