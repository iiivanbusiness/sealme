import { describe, expect, it } from "vitest";
import { captureErrorText } from "./capture-error";

describe("captureErrorText", () => {
  it("reads the string Tauri rejects with, and an Error", () => {
    expect(captureErrorText("Command discard_local_capture not allowed by ACL", "Fallback")).toBe("Command discard_local_capture not allowed by ACL");
    expect(captureErrorText(new Error("Capture is already running"), "Fallback")).toBe("Capture is already running");
  });

  it("pulls the server's message out of a turned-away upload, keeping where the audio is", () => {
    const err = 'Upload failed (409 Conflict): {"error":"This call is still being finished. Try again in a few minutes"}. The recording is saved at /tmp/call-1.wav.';
    expect(captureErrorText(err, "Fallback")).toBe("This call is still being finished. Try again in a few minutes. The recording is saved at /tmp/call-1.wav.");
    expect(captureErrorText('Upload failed (401 Unauthorized): {"error":"Invalid or expired token"}.', "Fallback")).toBe("Invalid or expired token.");
  });

  it("keeps an upload error that isn't the server's JSON as it came", () => {
    const err = "Upload failed (504 Gateway Timeout): An error occurred with your deployment.";
    expect(captureErrorText(err, "Fallback")).toBe(err);
    expect(captureErrorText("Upload failed: error sending request.", "Fallback")).toBe("Upload failed: error sending request.");
  });

  it("falls back when there's nothing to say", () => {
    expect(captureErrorText(undefined, "Something went wrong")).toBe("Something went wrong");
    expect(captureErrorText({}, "Something went wrong")).toBe("Something went wrong");
    expect(captureErrorText("  ", "Something went wrong")).toBe("Something went wrong");
  });
});
