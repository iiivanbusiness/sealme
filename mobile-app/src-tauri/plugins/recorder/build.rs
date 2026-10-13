// The commands the page can call. They're all in Swift
// (ios/Sources/RecorderPlugin.swift); listing them here makes a permission
// for each (permissions/default.toml turns them all on).
const COMMANDS: &[&str] = &["start", "pause", "resume", "stop", "status", "pending", "discard", "upload"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
