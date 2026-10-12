import { describe, expect, it } from "vitest";
import { isPhoneAppUserAgent, phoneAppRedirect } from "./phone-app";

describe("phone app", () => {
  it("tells the iPhone app from a browser", () => {
    expect(isPhoneAppUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 SealMeMobile/0.1")).toBe(true);
    expect(isPhoneAppUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe(false);
    expect(isPhoneAppUserAgent(null)).toBe(false);
  });

  it("sends contract pages to the Dashboard and Start a call to Notes", () => {
    expect(phoneAppRedirect("/deals/new")).toBe("/notes");
    expect(phoneAppRedirect("/deals")).toBe("/dashboard");
    expect(phoneAppRedirect("/deals/abc123/contract")).toBe("/dashboard");
    expect(phoneAppRedirect("/clients")).toBe("/dashboard");
    expect(phoneAppRedirect("/templates/new")).toBe("/dashboard");
    expect(phoneAppRedirect("/calendar")).toBe("/dashboard");
    expect(phoneAppRedirect("/analytics")).toBe("/dashboard");
  });

  it("leaves what the phone does alone", () => {
    for (const path of ["/dashboard", "/notes", "/leads", "/leads/abc123", "/calls", "/settings", "/team", "/dealsx"]) {
      expect(phoneAppRedirect(path)).toBeNull();
    }
  });
});
