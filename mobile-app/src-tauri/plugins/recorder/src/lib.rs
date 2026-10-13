use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_recorder);

// Meeting recording on the iPhone, all in Swift
// (ios/Sources/RecorderPlugin.swift), so it carries on with the screen
// locked. The page calls it with invoke("plugin:recorder|start") and so on:
// Tauri hands commands the Rust side doesn't have straight to the Swift
// plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("recorder")
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_recorder)?;
            Ok(())
        })
        .build()
}
