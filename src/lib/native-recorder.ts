import { invoke } from "@tauri-apps/api/core";

// The iPhone app's meeting recorder (mobile-app/src-tauri/plugins/recorder,
// in Swift). It records with the screen locked, pauses for a phone call and
// carries on after, and keeps every recording on the phone until the page
// says the notes are saved (discard), so pending() can offer it again after
// a crash or a failed upload. Only in the iPhone app (inMobileApp).

export type RecorderState = "idle" | "recording" | "paused" | "interrupted";
// uploadProgress is left out until a recording is being sent.
export type RecorderStatus = { state: RecorderState; seconds: number; level: number; uploadProgress?: number };
export type SavedRecording = { path: string; seconds: number; bytes: number; startedAt: number };

const call = <T>(command: string, args?: Record<string, unknown>) => invoke<T>(`plugin:recorder|${command}`, args);

export const recorder = {
  start: () => call<RecorderStatus>("start"),
  pause: () => call<RecorderStatus>("pause"),
  resume: () => call<RecorderStatus>("resume"),
  stop: () => call<SavedRecording>("stop"),
  status: () => call<RecorderStatus>("status"),
  pending: () => call<SavedRecording[]>("pending"),
  discard: (path: string) => call<void>("discard", { path }),
  upload: (o: { path: string; url: string; token: string; contentType: string }) => call<{ status: number; body: string }>("upload", o),
};

// What a rejected command says: Tauri rejects with the plugin's
// { message, code } or a plain string.
export function recorderError(err: unknown): { message: string; code?: string } {
  if (typeof err === "string") return { message: err };
  if (err && typeof err === "object" && "message" in err) {
    const e = err as { message?: unknown; code?: unknown };
    return { message: String(e.message), code: typeof e.code === "string" ? e.code : undefined };
  }
  return { message: "Something went wrong with the recorder" };
}

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
