//! The live-upload queue on disk: a small JSON index next to the cached WAV
//! files, rewritten whenever the queue changes. Audio that hadn't gone up yet
//! when the app quit or crashed mid-call is then still sent by that call's
//! next Stop & finish, instead of only sitting in the cache.

use std::path::{Path, PathBuf};

const INDEX_FILE: &str = "pending-chunks.json";
const INDEX_TEMP_FILE: &str = "pending-chunks.json.tmp";

#[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct Index {
    // Which call the chunks belong to, as `call_key` of its upload token.
    call: String,
    // The chunks' cache file names, oldest first.
    chunks: Vec<String>,
}

/// A stable fingerprint of an upload token (64-bit FNV-1a), so the index can
/// say which call its chunks are for without the token itself ever being
/// written to disk. Only ever compared with the token a Stop & finish passes
/// in, and the token is 32 random bytes, so nothing about it can be read
/// back out of this.
pub fn call_key(token: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in token.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Writes the index for `call`, or removes it when none of its chunks are on
/// disk (nothing left to send, or nothing that would survive a restart).
/// Goes through a temp file and a rename, so a crash mid-write leaves the old
/// index rather than half of a new one.
pub fn save<'a>(cache_dir: &Path, call: &str, chunks: impl IntoIterator<Item = &'a Path>) {
    let chunks: Vec<String> = chunks
        .into_iter()
        .filter_map(|path| path.file_name()?.to_str().map(str::to_string))
        .collect();
    if chunks.is_empty() {
        clear(cache_dir);
        return;
    }
    let index = Index { call: call.to_string(), chunks };
    let Ok(json) = serde_json::to_vec(&index) else { return };
    let temp = cache_dir.join(INDEX_TEMP_FILE);
    let written = std::fs::write(&temp, json).and_then(|()| std::fs::rename(&temp, cache_dir.join(INDEX_FILE)));
    if let Err(e) = written {
        eprintln!("[capture] couldn't save the upload queue: {e}");
    }
}

pub fn clear(cache_dir: &Path) {
    let _ = std::fs::remove_file(cache_dir.join(INDEX_FILE));
}

/// The call a saved queue is for, and those of its chunk files that are
/// still there, oldest first. None when there's no saved queue, or nothing
/// in it can be sent anymore (the index is removed then too).
pub fn load(cache_dir: &Path) -> Option<(String, Vec<PathBuf>)> {
    let text = std::fs::read_to_string(cache_dir.join(INDEX_FILE)).ok()?;
    let chunks = serde_json::from_str::<Index>(&text).ok().map(|index| {
        let paths: Vec<PathBuf> = index
            .chunks
            .iter()
            // Only files this app wrote into its own cache folder: a name
            // that points anywhere else is never read, let alone uploaded.
            .filter(|name| is_chunk_file_name(name))
            .map(|name| cache_dir.join(name))
            .filter(|path| path.is_file())
            .collect();
        (index.call, paths)
    });
    match chunks {
        Some((call, paths)) if !paths.is_empty() => Some((call, paths)),
        _ => {
            clear(cache_dir);
            None
        }
    }
}

// The names save_to_cache in lib.rs gives chunk files: call-<ms>-<n>.wav.
fn is_chunk_file_name(name: &str) -> bool {
    Path::new(name).file_name().and_then(|n| n.to_str()) == Some(name)
        && name.starts_with("call-")
        && name.ends_with(".wav")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!("sealme-saved-queue-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn call_key_is_stable_fnv1a() {
        assert_eq!(call_key(""), "cbf29ce484222325");
        assert_eq!(call_key("a"), "af63dc4c8601ec8c");
        assert_ne!(call_key("token-one"), call_key("token-two"));
    }

    #[test]
    fn saves_and_loads_the_queue_in_order() {
        let dir = temp_dir();
        let first = dir.join("call-100-0.wav");
        let second = dir.join("call-100-1.wav");
        std::fs::write(&first, b"one").unwrap();
        std::fs::write(&second, b"two").unwrap();

        save(&dir, "abc", [first.as_path(), second.as_path()]);
        assert_eq!(load(&dir), Some(("abc".to_string(), vec![first.clone(), second.clone()])));

        // A chunk that went up since is gone from the folder and is skipped.
        std::fs::remove_file(&first).unwrap();
        assert_eq!(load(&dir), Some(("abc".to_string(), vec![second])));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_queue_removes_the_index() {
        let dir = temp_dir();
        let chunk = dir.join("call-1-0.wav");
        std::fs::write(&chunk, b"x").unwrap();
        save(&dir, "abc", [chunk.as_path()]);
        assert!(dir.join(INDEX_FILE).is_file());

        save(&dir, "abc", []);
        assert!(!dir.join(INDEX_FILE).exists());
        assert_eq!(load(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn never_loads_files_outside_the_cache_or_not_written_by_the_app() {
        let dir = temp_dir();
        let outside = temp_dir();
        std::fs::write(outside.join("call-1-0.wav"), b"x").unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        let index = Index {
            call: "abc".to_string(),
            chunks: vec![
                outside.join("call-1-0.wav").display().to_string(),
                "../call-1-0.wav".to_string(),
                "notes.txt".to_string(),
            ],
        };
        std::fs::write(dir.join(INDEX_FILE), serde_json::to_vec(&index).unwrap()).unwrap();

        assert_eq!(load(&dir), None);
        assert!(!dir.join(INDEX_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn an_unreadable_index_is_dropped() {
        let dir = temp_dir();
        std::fs::write(dir.join(INDEX_FILE), b"{not json").unwrap();
        assert_eq!(load(&dir), None);
        assert!(!dir.join(INDEX_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
