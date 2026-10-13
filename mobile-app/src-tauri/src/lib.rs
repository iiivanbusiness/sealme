use tauri::{WebviewUrl, WebviewWindowBuilder};

// The iPhone app is the same SealMe as app.sealme.net, signed in with the
// same account, so leads, notes and calls are the ones on the computer. A
// simulator build can point it at the local dev server instead
// (`tauri ios build --features dev-server`).
#[cfg(not(feature = "dev-server"))]
const APP_URL: &str = "https://app.sealme.net";
#[cfg(feature = "dev-server")]
const APP_URL: &str = "http://localhost:3000";

// Runs before any page script. The web app reads __SEALME_MOBILE__ to show
// the phone's own options and keep the computer-only ones (Record locally,
// the companion window) out; see src/lib/native-shell.ts in the web app.
// It also stops iOS from zooming the page in whenever a form field with
// text under 16px is tapped, which a website gets but an app shouldn't, and
// lets the page run under the status bar (viewport-fit=cover), where the web
// app puts a bar in its own color (globals.css).
// Next.js can add or rewrite the viewport tag after this runs, so it's
// patched whenever it changes.
const INIT_SCRIPT: &str = r#"
window.__SEALME_MOBILE__ = true;
(function () {
  function patchViewport() {
    var metas = document.querySelectorAll('meta[name="viewport"]');
    for (var i = 0; i < metas.length; i++) {
      var content = metas[i].getAttribute("content") || "";
      var patched = content;
      if (patched.indexOf("maximum-scale") === -1) patched += ", maximum-scale=1";
      if (patched.indexOf("viewport-fit") === -1) patched += ", viewport-fit=cover";
      if (patched !== content) metas[i].setAttribute("content", patched);
    }
  }
  new MutationObserver(patchViewport).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["content"] });
  patchViewport();
})();
"#;

// iPhone WebKit's own user agent with "SealMeMobile" added, so the web app
// (and its server) can tell the phone app apart even before any script runs.
const USER_AGENT: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 SealMeMobile/0.1";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_recorder::init())
        .setup(|app| {
            let url = APP_URL.parse().expect("APP_URL is a URL");
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .initialization_script(INIT_SCRIPT)
                .user_agent(USER_AGENT)
                .build()?;
            // The page leaves room for the status bar itself; otherwise
            // WebKit adds the same space again, and loses it after some
            // navigations, so the header ends up under the clock.
            #[cfg(target_os = "ios")]
            window.with_webview(|webview| unsafe {
                use objc2::{msg_send, runtime::AnyObject};
                let wk_webview = webview.inner() as *mut AnyObject;
                let scroll_view: *mut AnyObject = msg_send![wk_webview, scrollView];
                // UIScrollViewContentInsetAdjustmentBehavior.never
                let _: () = msg_send![scroll_view, setContentInsetAdjustmentBehavior: 2isize];
            })?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running SealMe");
}
