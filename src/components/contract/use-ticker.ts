"use client";

import { useSyncExternalStore } from "react";

// The current time in whole seconds, ticking once a second while enabled.
// null on the server and while hydrating, so a timer renders nothing there
// instead of a value that no longer matches by the time the page is live.
function subscribeTicking(onChange: () => void): () => void {
  const id = window.setInterval(onChange, 1000);
  return () => window.clearInterval(id);
}
function subscribeIdle(): () => void {
  return () => {};
}
const nowSeconds = () => Math.floor(Date.now() / 1000);
const serverNow = () => null;

export function useNowSeconds(enabled: boolean): number | null {
  return useSyncExternalStore(enabled ? subscribeTicking : subscribeIdle, nowSeconds, serverNow);
}
