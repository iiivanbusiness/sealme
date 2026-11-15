"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { GUIDE_SEEN_KEY } from "@/lib/get-started";

// The setup guide's "look at this" steps, ticked off in this browser once
// they've been opened from the guide. Storage can be missing or blocked;
// then nothing is ticked and the guide still works.
//
// They're kept per person (GUIDE_SEEN_KEY plus the user id), so a second
// account in the same browser starts its own guide. The guide on the
// Dashboard says whose it is (OWNER_KEY): a tip opened from it, on any page,
// ticks off that person's step without having to know who's signed in.
const EVENT = "sealme-guide-seen";
const OWNER_KEY = "sealme.guide.owner";
export const guideSeenKey = (userId: string) => `${GUIDE_SEEN_KEY}.${userId}`;

function read(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function parse(raw: string): string[] {
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Makes this person the one the guide's tips tick off for. Steps kept from
// before they were per person (one list for the whole browser) move to
// them, once: whoever opens the guide first after that keeps their progress,
// and the next account starts clean.
export function claimGuide(userId: string): void {
  try {
    const storage = window.localStorage;
    storage.setItem(OWNER_KEY, userId);
    const old = storage.getItem(GUIDE_SEEN_KEY);
    if (old === null) return;
    if (storage.getItem(guideSeenKey(userId)) === null) storage.setItem(guideSeenKey(userId), old);
    storage.removeItem(GUIDE_SEEN_KEY);
    window.dispatchEvent(new Event(EVENT));
  } catch {}
}

export function useGuideSeen(userId: string): string[] {
  useEffect(() => claimGuide(userId), [userId]);
  const snapshot = useCallback(() => read(guideSeenKey(userId)), [userId]);
  const raw = useSyncExternalStore(subscribe, snapshot, () => "");
  return parse(raw);
}

// userId: whose step it is; without it, the person whose guide was opened
// last in this browser. With neither, the old shared list, which the next
// claimGuide hands to its person.
export function markGuideSeen(id: string, userId?: string): void {
  try {
    const owner = userId ?? window.localStorage.getItem(OWNER_KEY);
    const key = owner ? guideSeenKey(owner) : GUIDE_SEEN_KEY;
    const list = parse(read(key));
    if (list.includes(id)) return;
    window.localStorage.setItem(key, JSON.stringify([...list, id]));
    window.dispatchEvent(new Event(EVENT));
  } catch {}
}
