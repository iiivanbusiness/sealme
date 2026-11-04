//! Local call capture. On macOS, a safe Rust wrapper around the
//! ScreenCaptureKit bridge in `native/audio_capture.swift`; on Windows, a
//! thin re-export of the pure-Rust WASAPI implementation in
//! `audio_windows.rs`. Both produce the same stereo-WAV contract (left =
//! system audio, right = microphone) that the backend's Deepgram
//! multichannel transcription expects.

#[cfg(target_os = "macos")]
extern "C" {
    fn sealme_audio_start() -> i32;
    fn sealme_audio_is_capturing() -> i32;
    fn sealme_audio_stop_wav(out_ptr: *mut *mut u8, out_len: *mut usize) -> i32;
    fn sealme_audio_free(ptr: *mut u8, len: usize);
    fn sealme_audio_snapshot_wav(out_ptr: *mut *mut u8, out_len: *mut usize) -> i32;
}

#[cfg(target_os = "macos")]
pub fn start_capture() -> Result<(), String> {
    let code = unsafe { sealme_audio_start() };
    match code {
        0 => Ok(()),
        -100 => Err("Capture is already running".to_string()),
        -1 => Err("No display available to capture from".to_string()),
        -2 => Err("Couldn't start capture. Check Screen Recording permission in System Settings".to_string()),
        -3 => Err("Couldn't start the microphone. Check your input device in System Settings > Sound".to_string()),
        -4 => Err("SealMe doesn't have microphone access. Turn it on in System Settings > Privacy & Security > Microphone".to_string()),
        -5 => Err("Your sound input isn't a microphone. Pick one under Input in System Settings > Sound".to_string()),
        other => Err(format!("Unknown audio capture error: {other}")),
    }
}

#[cfg(target_os = "macos")]
pub fn is_capturing() -> bool {
    unsafe { sealme_audio_is_capturing() != 0 }
}

/// Stops the active capture and returns the recorded call as a 16-bit PCM
/// WAV file. Returns `Ok(None)` if nothing was captured (e.g. a silent call).
#[cfg(target_os = "macos")]
pub fn stop_capture_wav() -> Result<Option<Vec<u8>>, String> {
    let mut ptr: *mut u8 = std::ptr::null_mut();
    let mut len: usize = 0;

    let code = unsafe { sealme_audio_stop_wav(&mut ptr, &mut len) };
    if code != 0 || ptr.is_null() {
        return Ok(None);
    }

    let wav = unsafe { std::slice::from_raw_parts(ptr, len).to_vec() };
    unsafe { sealme_audio_free(ptr, len) };
    Ok(Some(wav))
}

/// Non-destructive: returns only the audio captured since the last snapshot
/// (or since start) on both channels, and advances the checkpoint. Capture
/// keeps running — used for periodic live transcription passes during the
/// call, mirroring how the Recall bot flow updates deal terms live instead
/// of only once at the end. Returns `Ok(None)` if nothing new has arrived.
#[cfg(target_os = "macos")]
pub fn snapshot_delta_wav() -> Result<Option<Vec<u8>>, String> {
    let mut ptr: *mut u8 = std::ptr::null_mut();
    let mut len: usize = 0;

    let code = unsafe { sealme_audio_snapshot_wav(&mut ptr, &mut len) };
    if code != 0 || ptr.is_null() {
        return Ok(None);
    }

    let wav = unsafe { std::slice::from_raw_parts(ptr, len).to_vec() };
    unsafe { sealme_audio_free(ptr, len) };
    Ok(Some(wav))
}

#[cfg(target_os = "windows")]
pub use crate::audio_windows::{is_capturing, snapshot_delta_wav, start_capture, stop_capture_wav};

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn start_capture() -> Result<(), String> {
    Err("Local call capture is only supported on macOS and Windows right now".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn is_capturing() -> bool {
    false
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn stop_capture_wav() -> Result<Option<Vec<u8>>, String> {
    Err("Local call capture is only supported on macOS and Windows right now".to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn snapshot_delta_wav() -> Result<Option<Vec<u8>>, String> {
    Err("Local call capture is only supported on macOS and Windows right now".to_string())
}
