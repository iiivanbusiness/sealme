mod audio;
#[cfg(target_os = "windows")]
mod audio_windows;
mod wav;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};
#[cfg(all(not(feature = "mas"), not(target_os = "windows")))]
use tauri::window::{Effect, EffectsBuilder};
#[cfg(all(not(feature = "mas"), target_os = "macos"))]
use tauri::window::EffectState;
use tauri::Manager;

// The webview is pinned to this origin (see tauri.conf.json) — hardcoded
// here too so the upload target can't be influenced by anything the loaded
// page passes in.
const APP_BASE_URL: &str = "https://app.sealme.net";

// The floating companion window's own route — a chrome-less view of the
// same app.sealme.net session (see src/app/companion/page.tsx), not the
// full sidebared app. The rail is a second, separate route/window — see
// src/app/companion/rail/page.tsx. Not offered on Windows yet (see the
// Windows arms of toggle_companion_rail/select_companion_view below), so
// none of this — the URLs, sizing, positioning, or window-building — is
// compiled into a Windows build at all.
#[cfg(not(target_os = "windows"))]
const COMPANION_URL: &str = "https://app.sealme.net/companion";
#[cfg(not(target_os = "windows"))]
const RAIL_URL: &str = "https://app.sealme.net/companion/rail";
#[cfg(not(target_os = "windows"))]
const COMPANION_WIDTH: f64 = 340.0;
#[cfg(not(target_os = "windows"))]
const COMPANION_HEIGHT: f64 = 520.0;
#[cfg(not(target_os = "windows"))]
const RAIL_WIDTH: f64 = 44.0;
#[cfg(not(target_os = "windows"))]
const RAIL_HEIGHT: f64 = 172.0;
#[cfg(not(target_os = "windows"))]
const COMPANION_MARGIN: f64 = 16.0;
#[cfg(not(target_os = "windows"))]
const COMPANION_GAP: f64 = 8.0;
#[cfg(all(not(feature = "mas"), target_os = "macos"))]
const COMPANION_RADIUS: f64 = 16.0;

// How often to send a live chunk while the call is still going, mirroring
// the ~1 minute delay the existing Recall bot flow already has. Counted from
// the start of each pass, so a slow upload doesn't stretch the next chunk.
const LIVE_UPDATE_INTERVAL_SECS: u64 = 60;

// Vercel turns away a request body over 4.5 MB before the route even runs.
// 4 MB is about 62 s of the 16 kHz stereo audio both capture backends
// record, so a normal live chunk goes up whole, and only a longer stretch
// (the whole call on stop, or audio that piled up while uploads failed) is
// sent in pieces.
const MAX_CHUNK_BYTES: usize = 4_000_000;

// The server can't run a request longer than this anyway. Without a limit,
// a stalled connection would hold up every later chunk, Stop & finish too.
const UPLOAD_TIMEOUT_SECS: u64 = 300;

// The running live-update loop's wake-up channel, if there is one. Taking or
// replacing the sender ends that loop right away, even mid-sleep. A single
// global is fine here, same as the Swift side's CaptureSession.shared: there
// is only ever one call being recorded at a time.
static LIVE_LOOP: Mutex<Option<mpsc::Sender<()>>> = Mutex::new(None);

// Audio recorded under the current token that the server hasn't accepted
// yet. Whoever holds this lock is the only one uploading, so chunks always
// reach the server in the order they were recorded.
static UPLOADS: tauri::async_runtime::Mutex<Option<Upload>> = tauri::async_runtime::Mutex::const_new(None);

// Keeps cache file names unique when one chunk is saved as several pieces.
static SAVED_CHUNKS: AtomicU64 = AtomicU64::new(0);

#[derive(serde::Serialize)]
struct StopCaptureResult {
    ok: bool,
    error: Option<String>,
}

struct PendingChunk {
    wav: Vec<u8>,
    // Copy on disk so a flaky connection doesn't lose audio. Only deleted
    // once the backend confirms it processed the chunk.
    saved_at: Option<PathBuf>,
}

// Chunks recorded under one token, oldest first, waiting to go up.
struct Upload {
    token: String,
    pending: VecDeque<PendingChunk>,
}

impl Upload {
    fn enqueue(&mut self, app: &tauri::AppHandle, wav: Vec<u8>) {
        for piece in wav::split(wav, MAX_CHUNK_BYTES) {
            let saved_at = save_to_cache(app, &piece);
            self.pending.push_back(PendingChunk { wav: piece, saved_at });
        }
    }
}

fn live_loop() -> MutexGuard<'static, Option<mpsc::Sender<()>>> {
    LIVE_LOOP.lock().unwrap_or_else(PoisonError::into_inner)
}

// Anything still queued under another token is left over from a call that
// was discarded, and can't be sent anymore.
fn upload_for<'a>(slot: &'a mut Option<Upload>, token: &str) -> &'a mut Upload {
    if slot.as_ref().is_some_and(|u| u.token != token) {
        *slot = None;
    }
    slot.get_or_insert_with(|| Upload { token: token.to_string(), pending: VecDeque::new() })
}

#[tauri::command]
fn start_local_capture() -> Result<(), String> {
    audio::start_capture()
}

// Called once the caller has a token (i.e. once startLocalCapture's deal
// actually exists). Starts a background loop that periodically uploads
// whatever's been captured since the last chunk, so deal terms fill in
// while the call is still happening instead of only at the very end.
#[tauri::command]
fn begin_live_updates(app: tauri::AppHandle, token: String) {
    let (wake, stop) = mpsc::channel();
    // Replacing the sender also ends a loop left over from an earlier call on
    // the spot, instead of letting it wake up later and send this call's
    // audio under that call's token.
    *live_loop() = Some(wake);
    std::thread::spawn(move || live_update_loop(app, token, stop));
}

fn live_update_loop(app: tauri::AppHandle, token: String, stop: mpsc::Receiver<()>) {
    let interval = Duration::from_secs(LIVE_UPDATE_INTERVAL_SECS);
    let mut next_pass = Instant::now() + interval;
    loop {
        let wait = next_pass.saturating_duration_since(Instant::now());
        if !matches!(stop.recv_timeout(wait), Err(mpsc::RecvTimeoutError::Timeout)) {
            break;
        }
        next_pass = Instant::now() + interval;

        let mut slot = UPLOADS.blocking_lock();
        let snapshot = {
            // Checked again under the lock stop and discard take to end this
            // loop: once they have, the audio from here on is theirs (or
            // already the next call's), so this pass must not take any.
            let _live = live_loop();
            if !matches!(stop.try_recv(), Err(mpsc::TryRecvError::Empty)) {
                break;
            }
            audio::snapshot_delta_wav()
        };
        let upload = upload_for(&mut slot, &token);
        if let Ok(Some(wav)) = snapshot {
            upload.enqueue(&app, wav);
        }
        // Also retries whatever an earlier pass couldn't get through.
        let result = tauri::async_runtime::block_on(send_pending(upload, false));
        if let Some(error) = result.error {
            eprintln!("[capture] live chunk not sent yet, will retry: {error}");
        }
    }
}

#[tauri::command]
fn is_local_capturing() -> bool {
    audio::is_capturing()
}

// Top-right-anchored logical position for the rail on whatever monitor it's
// opening on. Falls back to a fixed spot if the OS can't tell us about a
// primary monitor (shouldn't normally happen, but the builder still needs
// *some* position rather than failing the whole toggle).
#[cfg(not(target_os = "windows"))]
fn rail_position(app: &tauri::AppHandle) -> (f64, f64) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let mon_pos = monitor.position();
        let mon_size = monitor.size();
        let mon_x = mon_pos.x as f64 / scale;
        let mon_y = mon_pos.y as f64 / scale;
        let mon_w = mon_size.width as f64 / scale;
        return (mon_x + mon_w - RAIL_WIDTH - COMPANION_MARGIN, mon_y + COMPANION_MARGIN);
    }
    (100.0, 100.0)
}

// The content window sits immediately to the left of the rail, top-aligned
// with it — computed independently from the same monitor geometry (not by
// querying the rail's live position) so the two always line up consistently
// even if this runs before the rail has actually been shown yet.
#[cfg(not(target_os = "windows"))]
fn content_position(app: &tauri::AppHandle) -> (f64, f64) {
    let (rail_x, rail_y) = rail_position(app);
    (rail_x - COMPANION_GAP - COMPANION_WIDTH, rail_y)
}

// transparent() + a native blur effect gives the window a frosted,
// blurred-desktop-behind panel look, with rounded corners from `radius` on
// macOS. The webview's own CSS paints nothing solid behind its content (see
// CompanionPanel.tsx / CompanionRail.tsx) so the blur actually shows through
// instead of sitting behind an opaque backing. Not applied for `mas` builds
// — see the tauri dependency comment in Cargo.toml for why the Cargo feature
// itself still has to stay unconditionally on regardless.
//
// Windows-only builds never call this at all (the companion/rail windows
// aren't offered there — see the Windows arms of toggle_companion_rail/
// select_companion_view below), so this only has to choose between macOS's
// HudWindow vibrancy and the plain opaque fallback `mas` (and Linux, which
// has no vibrancy story here) use.
#[cfg(not(target_os = "windows"))]
fn apply_glass_or_plain<'a>(
    builder: tauri::WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle>,
) -> tauri::WebviewWindowBuilder<'a, tauri::Wry, tauri::AppHandle> {
    #[cfg(all(not(feature = "mas"), target_os = "macos"))]
    {
        builder.transparent(true).effects(
            EffectsBuilder::new()
                .effect(Effect::HudWindow)
                .state(EffectState::Active)
                .radius(COMPANION_RADIUS)
                .build(),
        )
    }
    #[cfg(any(feature = "mas", not(target_os = "macos")))]
    {
        builder.background_color(tauri::webview::Color(245, 245, 247, 255))
    }
}

#[cfg(not(target_os = "windows"))]
fn build_rail_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    let (x, y) = rail_position(app);
    eprintln!("[companion] creating rail window at ({x}, {y}), url={RAIL_URL}");
    let url = tauri::Url::parse(RAIL_URL).map_err(|e| {
        eprintln!("[companion] bad rail URL: {e}");
        e.to_string()
    })?;
    let builder = tauri::WebviewWindowBuilder::new(app, "rail", tauri::WebviewUrl::External(url))
        .title("SealMe")
        .inner_size(RAIL_WIDTH, RAIL_HEIGHT)
        .position(x, y)
        .always_on_top(true)
        .decorations(false)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(true)
        .focused(true)
        // Without this, a click on the panel while it's not the active
        // window only activates/focuses it — the click itself doesn't
        // reach any button, you'd need a second click. An always-on-top
        // utility panel like this one should feel clickable first try.
        .accept_first_mouse(true);
    match apply_glass_or_plain(builder).build() {
        Ok(w) => {
            eprintln!("[companion] rail window created");
            Ok(w)
        }
        Err(e) => {
            eprintln!("[companion] failed to create rail window: {e}");
            Err(e.to_string())
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn build_content_window(app: &tauri::AppHandle, view: &str) -> Result<tauri::WebviewWindow, String> {
    let (x, y) = content_position(app);
    let full_url = format!("{COMPANION_URL}?view={view}");
    eprintln!("[companion] creating content window at ({x}, {y}), url={full_url}");
    let url = tauri::Url::parse(&full_url).map_err(|e| {
        eprintln!("[companion] bad content URL: {e}");
        e.to_string()
    })?;
    let builder = tauri::WebviewWindowBuilder::new(app, "companion", tauri::WebviewUrl::External(url))
        .title("SealMe Companion")
        .inner_size(COMPANION_WIDTH, COMPANION_HEIGHT)
        .position(x, y)
        .always_on_top(true)
        .decorations(false)
        .skip_taskbar(true)
        .resizable(true)
        .shadow(true)
        .focused(true)
        .accept_first_mouse(true);
    match apply_glass_or_plain(builder).build() {
        Ok(w) => {
            eprintln!("[companion] content window created");
            Ok(w)
        }
        Err(e) => {
            eprintln!("[companion] failed to create content window: {e}");
            Err(e.to_string())
        }
    }
}

// Not offered on Windows yet — CompanionToggleButton.tsx hides the only UI
// entry point there already, but this refuses at the command level too
// (rather than just leaving the button hidden and trusting nothing else
// ever calls it), so nothing downstream — window creation, positioning,
// the vibrancy code — ever runs on Windows regardless of caller.
#[cfg(target_os = "windows")]
#[tauri::command]
fn toggle_companion_rail() -> Result<(), String> {
    Err("The floating companion panel isn't available on Windows yet".to_string())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn select_companion_view(_view: String) -> Result<(), String> {
    Err("The floating companion panel isn't available on Windows yet".to_string())
}

// Manual toggle only — not tied to call start/stop. Shows/hides the small
// persistent rail (and the content window along with it, if one happens to
// be open) in sync with the main window — exactly one of "main" / "rail" is
// visible after this returns; the content window is independent from then
// on, only ever shown via select_companion_view. Called from a button in
// the main window's AppShell, and symmetrically from a "back to app"
// control on the rail itself and inside the content window's header. Logs
// every step to stderr (visible in the `tauri dev` terminal) since this has
// no other feedback channel if something in here fails.
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn toggle_companion_rail(app: tauri::AppHandle) -> Result<(), String> {
    eprintln!("[companion] rail toggle invoked");
    let main = app.get_webview_window("main");
    if main.is_none() {
        eprintln!("[companion] warning: no window labeled \"main\" found");
    }

    if let Some(rail) = app.get_webview_window("rail") {
        let visible = rail.is_visible().map_err(|e| {
            eprintln!("[companion] rail is_visible failed: {e}");
            e.to_string()
        })?;
        eprintln!("[companion] existing rail found, visible={visible}");
        if visible {
            // Show main BEFORE hiding the rail — never let every window be
            // invisible at once, even for an instant. Tauri/macOS treats
            // "zero visible windows" as "nothing left to run for" and quits
            // the whole app out from under you if the calls land in the
            // other order (confirmed: this crashed the dev process).
            if let Some(main) = main {
                main.show().map_err(|e| { eprintln!("[companion] main.show failed: {e}"); e.to_string() })?;
                main.set_focus().map_err(|e| { eprintln!("[companion] main.set_focus failed: {e}"); e.to_string() })?;
            }
            rail.hide().map_err(|e| { eprintln!("[companion] rail hide failed: {e}"); e.to_string() })?;
            if let Some(content) = app.get_webview_window("companion") {
                content.hide().map_err(|e| { eprintln!("[companion] content hide failed: {e}"); e.to_string() })?;
            }
            eprintln!("[companion] rail hidden, main restored");
            return Ok(());
        }
        let (x, y) = rail_position(&app);
        rail.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))
            .map_err(|e| { eprintln!("[companion] rail set_position failed: {e}"); e.to_string() })?;
        rail.show().map_err(|e| { eprintln!("[companion] rail show failed: {e}"); e.to_string() })?;
        rail.set_focus().map_err(|e| { eprintln!("[companion] rail set_focus failed: {e}"); e.to_string() })?;
        if let Some(main) = main {
            main.hide().map_err(|e| { eprintln!("[companion] main.hide failed: {e}"); e.to_string() })?;
        }
        eprintln!("[companion] rail shown");
        return Ok(());
    }

    eprintln!("[companion] no existing rail, building one");
    let rail = build_rail_window(&app)?;
    rail.show().map_err(|e| { eprintln!("[companion] rail show failed: {e}"); e.to_string() })?;
    rail.set_focus().map_err(|e| { eprintln!("[companion] rail set_focus failed: {e}"); e.to_string() })?;
    if let Some(main) = main {
        main.hide().map_err(|e| { eprintln!("[companion] main.hide failed: {e}"); e.to_string() })?;
    }
    eprintln!("[companion] rail shown (first time)");
    Ok(())
}

// Picks (or collapses) the content window from the rail. Creates it on
// first use, positioned next to wherever the rail currently is; after
// that, re-shows/navigates the same window rather than recreating it each
// time — WebviewWindow::navigate() changes its URL in place. Picking the
// view that's already showing collapses the window back to rail-only, the
// same "tap the active icon again to close" the rail itself uses.
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn select_companion_view(app: tauri::AppHandle, view: String) -> Result<(), String> {
    eprintln!("[companion] select_companion_view({view})");

    if let Some(content) = app.get_webview_window("companion") {
        let visible = content.is_visible().map_err(|e| { eprintln!("[companion] content is_visible failed: {e}"); e.to_string() })?;
        let current_url = content.url().map(|u| u.to_string()).unwrap_or_default();
        let already_on_view = current_url.ends_with(&format!("view={view}"));
        eprintln!("[companion] existing content found, visible={visible}, already_on_view={already_on_view}");

        if visible && already_on_view {
            content.hide().map_err(|e| { eprintln!("[companion] content hide failed: {e}"); e.to_string() })?;
            eprintln!("[companion] content hidden (same view re-picked)");
            return Ok(());
        }
        if !already_on_view {
            let full_url = format!("{COMPANION_URL}?view={view}");
            let url = tauri::Url::parse(&full_url).map_err(|e| { eprintln!("[companion] bad content URL: {e}"); e.to_string() })?;
            content.navigate(url).map_err(|e| { eprintln!("[companion] navigate failed: {e}"); e.to_string() })?;
        }
        let (x, y) = content_position(&app);
        content
            .set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))
            .map_err(|e| { eprintln!("[companion] content set_position failed: {e}"); e.to_string() })?;
        content.show().map_err(|e| { eprintln!("[companion] content show failed: {e}"); e.to_string() })?;
        content.set_focus().map_err(|e| { eprintln!("[companion] content set_focus failed: {e}"); e.to_string() })?;
        eprintln!("[companion] content shown at view={view}");
        return Ok(());
    }

    eprintln!("[companion] no existing content window, building one at view={view}");
    let content = build_content_window(&app, &view)?;
    content.show().map_err(|e| { eprintln!("[companion] content show failed: {e}"); e.to_string() })?;
    content.set_focus().map_err(|e| { eprintln!("[companion] content set_focus failed: {e}"); e.to_string() })?;
    eprintln!("[companion] content shown (first time) at view={view}");
    Ok(())
}

// Used when capture started successfully but the deal it was meant for
// couldn't be created (e.g. plan call limit reached) — stops the recording
// and throws the audio away rather than leaving it running with nothing to
// upload it to.
#[tauri::command]
fn discard_local_capture() -> Result<(), String> {
    live_loop().take();
    audio::stop_capture_wav()?;
    Ok(())
}

#[tauri::command]
async fn stop_local_capture_and_upload(app: tauri::AppHandle, token: String) -> Result<StopCaptureResult, String> {
    live_loop().take();
    // Waits out a live pass that's still uploading, so its chunk lands first.
    let mut slot = UPLOADS.lock().await;
    let upload = upload_for(&mut slot, &token);

    // Whatever arrived since the last live chunk (or the whole call, if live
    // updates never got a chance to fire). Chunks the server already took
    // are transcribed and appended there, so none of those go again. On a
    // retry after a failed upload, capture has already stopped: nothing new
    // comes in here, and exactly what didn't get through is sent again.
    if let Some(wav) = audio::snapshot_delta_wav()? {
        upload.enqueue(&app, wav);
    }
    audio::stop_capture_wav()?;

    Ok(send_pending(upload, true).await)
}

/// Sends what's queued, oldest first, and stops at the first chunk that
/// doesn't get through, leaving it and everything after it queued for the
/// next try. With `finish`, the last chunk goes up as the final one, which
/// ends the call on the server; that one goes even with no audio in it.
async fn send_pending(upload: &mut Upload, finish: bool) -> StopCaptureResult {
    if finish && upload.pending.is_empty() {
        upload.pending.push_back(PendingChunk { wav: Vec::new(), saved_at: None });
    }
    while let Some(chunk) = upload.pending.front() {
        let is_final = finish && upload.pending.len() == 1;
        let result = upload_chunk(&upload.token, chunk, is_final).await;
        if !result.ok {
            return result;
        }
        upload.pending.pop_front();
    }
    StopCaptureResult { ok: true, error: None }
}

fn save_to_cache(app: &tauri::AppHandle, wav: &[u8]) -> Option<PathBuf> {
    let cache_dir = app.path().app_cache_dir().ok()?;
    let _ = std::fs::create_dir_all(&cache_dir);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = SAVED_CHUNKS.fetch_add(1, Ordering::Relaxed);
    let path = cache_dir.join(format!("call-{millis}-{n}.wav"));
    std::fs::write(&path, wav).ok()?;
    Some(path)
}

/// Shared by both the periodic live pings and the final call.
async fn upload_chunk(token: &str, chunk: &PendingChunk, is_final: bool) -> StopCaptureResult {
    let client = reqwest::Client::new();
    let url = format!("{APP_BASE_URL}/api/local-capture/transcribe?final={}", if is_final { "true" } else { "false" });
    let send_result = client
        .post(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "audio/wav")
        .timeout(Duration::from_secs(UPLOAD_TIMEOUT_SECS))
        .body(chunk.wav.clone())
        .send()
        .await;

    let saved = chunk.saved_at.as_ref().map(|p| format!(" The recording is saved at {}.", p.display())).unwrap_or_default();
    match send_result {
        Ok(res) if res.status().is_success() => {
            if let Some(path) = &chunk.saved_at {
                let _ = std::fs::remove_file(path);
            }
            StopCaptureResult { ok: true, error: None }
        }
        Ok(res) => {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            StopCaptureResult { ok: false, error: Some(format!("Upload failed ({status}): {body}.{saved}")) }
        }
        Err(e) => StopCaptureResult { ok: false, error: Some(format!("Upload failed: {e}.{saved}")) },
    }
}

// Checks https://app.sealme.net/updates/latest.json on startup and, if a
// newer version is signed and available, downloads and installs it, then
// restarts so it takes effect. Entirely on the Rust side — the webview never
// gets a say in whether/when this happens, since it's just the remote page,
// not something we want triggering updates.
//
// Not compiled into `mas` builds at all — Apple doesn't allow apps
// distributed through the Mac App Store to update themselves; the Store is
// the only update channel there.
#[cfg(all(desktop, not(feature = "mas")))]
async fn check_for_update(app: tauri::AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("updater unavailable: {e}");
            return;
        }
    };

    eprintln!("[updater] checking...");
    match updater.check().await {
        Ok(Some(update)) => {
            eprintln!("[updater] update found: {} -> {}", update.current_version, update.version);
            let install = update.download_and_install(|_chunk, _total| {}, || {}).await;
            match install {
                Ok(()) => {
                    eprintln!("[updater] installed, restarting");
                    tauri::process::restart(&app.env());
                }
                Err(e) => eprintln!("[updater] install failed: {e}"),
            }
        }
        Ok(None) => eprintln!("[updater] no update available"),
        Err(e) => eprintln!("[updater] check failed: {e}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `mut` is only needed to re-assign it in the updater block below, which
    // `mas` builds compile out entirely.
    #[cfg_attr(feature = "mas", allow(unused_mut))]
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());

    // Updater is desktop-only — there's no mobile build of this app today,
    // but gating it keeps that true if one is ever added later. Also
    // skipped for `mas` builds (see check_for_update's doc comment above).
    #[cfg(all(desktop, not(feature = "mas")))]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .setup(|app| {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(check_for_update(handle));
                Ok(())
            });
    }

    builder
        .invoke_handler(tauri::generate_handler![
            start_local_capture,
            begin_live_updates,
            is_local_capturing,
            discard_local_capture,
            stop_local_capture_and_upload,
            toggle_companion_rail,
            select_companion_view
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
