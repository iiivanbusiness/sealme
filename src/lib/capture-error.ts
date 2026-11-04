// What went wrong with a call recorded in the desktop app, in words the rep
// can read. Tauri rejects a command with its error string, not an Error, and
// an upload the server turned away comes back from the app as
// `Upload failed (409 Conflict): {"error":"..."}. The recording is saved at ...`,
// so the server's own message is pulled out of that, keeping where the
// audio was saved.
export function captureErrorText(err: unknown, fallback: string): string {
  const text = (typeof err === "string" ? err : err instanceof Error ? err.message : "").trim();
  if (!text) return fallback;
  const upload = text.match(/^Upload failed \([^)]*\): (\{[\s\S]*\})\.?([\s\S]*)$/);
  if (upload) {
    try {
      const { error } = JSON.parse(upload[1]) as { error?: unknown };
      if (typeof error === "string" && error.trim()) return `${error.trim().replace(/\.$/, "")}.${upload[2]}`;
    } catch {
      // Not the server's JSON (a proxy's error page): the text as it came.
    }
  }
  return text;
}
