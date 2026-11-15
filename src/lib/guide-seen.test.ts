import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUIDE_SEEN_KEY } from "./get-started";
import { claimGuide, guideSeenKey, markGuideSeen } from "./guide-seen";

// A browser's storage, enough for the guide: getItem, setItem, removeItem.
let store: Map<string, string>;
const seen = (key: string) => JSON.parse(store.get(key) ?? "[]");

describe("seen guide steps", () => {
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
      dispatchEvent: vi.fn(),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps each person's steps apart in the same browser", () => {
    claimGuide("ana");
    markGuideSeen("leads");
    claimGuide("bo");
    markGuideSeen("todo");
    expect(seen(guideSeenKey("ana"))).toEqual(["leads"]);
    expect(seen(guideSeenKey("bo"))).toEqual(["todo"]);
  });

  it("ticks off the step of the person named, whoever opened the guide last", () => {
    claimGuide("bo");
    markGuideSeen("lead", "ana");
    expect(seen(guideSeenKey("ana"))).toEqual(["lead"]);
    expect(store.has(guideSeenKey("bo"))).toBe(false);
  });

  it("hands the old shared list to the first person once, and the next one starts clean", () => {
    store.set(GUIDE_SEEN_KEY, JSON.stringify(["lead", "todo"]));
    claimGuide("ana");
    expect(seen(guideSeenKey("ana"))).toEqual(["lead", "todo"]);
    expect(store.has(GUIDE_SEEN_KEY)).toBe(false);
    claimGuide("bo");
    expect(store.has(guideSeenKey("bo"))).toBe(false);
  });

  it("doesn't let the old list overwrite steps a person already has", () => {
    store.set(guideSeenKey("ana"), JSON.stringify(["leads"]));
    store.set(GUIDE_SEEN_KEY, JSON.stringify(["lead"]));
    claimGuide("ana");
    expect(seen(guideSeenKey("ana"))).toEqual(["leads"]);
    expect(store.has(GUIDE_SEEN_KEY)).toBe(false);
  });

  it("keeps working when storage is blocked", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
      dispatchEvent: vi.fn(),
    });
    expect(() => claimGuide("ana")).not.toThrow();
    expect(() => markGuideSeen("leads")).not.toThrow();
  });
});
