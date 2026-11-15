import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/font/google", () => {
  const font = () => ({ variable: "font" });
  return { Geist: font, Inter: font, Baloo_2: font };
});

import RootLayout from "./layout";

const html = renderToStaticMarkup(RootLayout({ children: null } as LayoutProps<"/">));
const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
const script = head.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

// Runs the script the way the browser would, against a stand-in <html>.
function run(opts: { window?: object; userAgent?: string; theme?: string | null; storageThrows?: boolean } = {}) {
  const attrs = new Map<string, string>();
  const root = { setAttribute: (name: string, value: string) => void attrs.set(name, value) };
  const localStorage = {
    getItem: () => {
      if (opts.storageThrows) throw new Error("blocked");
      return opts.theme ?? null;
    },
  };
  const navigator = { userAgent: opts.userAgent ?? "Mozilla/5.0 Safari" };
  const runOnce = () => new Function("window", "document", "navigator", "localStorage", script)(opts.window ?? {}, { documentElement: root }, navigator, localStorage);
  runOnce();
  runOnce();
  return Object.fromEntries(attrs);
}

describe("root layout's theme script", () => {
  // next/script's beforeInteractive only queues the script (self.__next_s)
  // until the main JS bundle loads, after the first paint.
  it("is a plain inline script in <head>, so it runs before the first paint", () => {
    expect(script).toContain("data-desktop");
    expect(html).not.toContain("__next_s");
  });

  it("sets nothing in a browser with the light theme", () => {
    expect(run()).toEqual({});
  });

  it("applies the saved dark theme", () => {
    expect(run({ theme: "dark" })).toEqual({ "data-theme": "dark" });
  });

  it("marks the desktop app", () => {
    expect(run({ window: { __TAURI_INTERNALS__: {} } })).toEqual({ "data-desktop": "" });
  });

  it("marks the iPhone app by its window flag or its user agent", () => {
    expect(run({ window: { __TAURI_INTERNALS__: {}, __SEALME_MOBILE__: true } })).toEqual({ "data-desktop": "", "data-mobile-app": "" });
    expect(run({ userAgent: "Mozilla/5.0 iPhone SealMeMobile" })).toEqual({ "data-mobile-app": "" });
  });

  it("still marks the app when storage is blocked", () => {
    expect(run({ window: { __TAURI_INTERNALS__: {} }, storageThrows: true })).toEqual({ "data-desktop": "" });
  });
});
