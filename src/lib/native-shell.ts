import { useSyncExternalStore } from "react";

// Where the page is running: a browser, the desktop app (Tauri on Mac and
// Windows) or the iPhone app (Tauri on iOS, which sets
// window.__SEALME_MOBILE__ before any page script runs and adds
// "SealMeMobile" to its user agent). Both apps expose
// __TAURI_INTERNALS__, so the desktop-only features (Record locally, the
// companion window, continuing a captured call) check inDesktopApp, not
// just for Tauri. Client-side only: on the server both are false.
export function inMobileApp(): boolean {
  if (typeof window === "undefined") return false;
  return "__SEALME_MOBILE__" in window || navigator.userAgent.includes("SealMeMobile");
}

export function inDesktopApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && !inMobileApp();
}

// For components: null while the page is being hydrated (the server can't
// know), then whether this is the desktop app. Nothing to subscribe to; it
// never changes once the page is open.
const noSubscription = () => () => {};
export function useInDesktopApp(): boolean | null {
  return useSyncExternalStore(noSubscription, inDesktopApp, () => null);
}
