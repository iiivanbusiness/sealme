"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

// Terms the rep marked as asked during a call ("Mark as asked"). Only for
// this viewer, in this browser: there is nowhere on the deal to keep it,
// and it only matters while the call lasts. Falls back to memory when
// localStorage is unavailable (private windows).

const EVENT = "sealme:asked-changed";
const memory = new Map<string, string>();

function read(storageKey: string): string {
  try {
    return localStorage.getItem(storageKey) ?? memory.get(storageKey) ?? "";
  } catch {
    return memory.get(storageKey) ?? "";
  }
}

function parse(raw: string): Set<string> {
  try {
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

export function useAskedKeys(dealId: string): [ReadonlySet<string>, (fieldKey: string) => void] {
  const storageKey = `sealme:asked:${dealId}`;
  const subscribe = useCallback(
    (onChange: () => void) => {
      const onStorage = (e: StorageEvent) => {
        if (e.key === null || e.key === storageKey) onChange();
      };
      window.addEventListener("storage", onStorage);
      window.addEventListener(EVENT, onChange);
      return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener(EVENT, onChange);
      };
    },
    [storageKey],
  );
  const raw = useSyncExternalStore(subscribe, () => read(storageKey), () => "");
  const asked = useMemo(() => parse(raw), [raw]);

  const markAsked = useCallback(
    (fieldKey: string) => {
      const next = JSON.stringify([...new Set([...parse(read(storageKey)), fieldKey])]);
      try {
        localStorage.setItem(storageKey, next);
      } catch {
        memory.set(storageKey, next);
      }
      window.dispatchEvent(new Event(EVENT));
    },
    [storageKey],
  );

  return [asked, markAsked];
}
