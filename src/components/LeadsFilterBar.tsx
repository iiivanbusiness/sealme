"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { isPipelineStage, PIPELINE_STAGES, PIPELINE_STAGE_LABEL } from "@/lib/pipeline-stages";
import { parseLeadTab, tabForStage } from "@/lib/lead-tab-stage";

function setOrDelete(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
  else params.delete(key);
}

// Same URL-driven pattern as DealsFilterBar: every control writes to the
// query string and the page re-queries, so a filtered list is a link.
export default function LeadsFilterBar({ owners, showOwnerFilter, campaigns = [] }: { owners: { id: string; name: string }[]; showOwnerFilter: boolean; campaigns?: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.toString();
  const urlQ = searchParams.get("q") ?? "";
  const [q, setQ] = useState(urlQ);
  const [seen, setSeen] = useState(current);
  const [lastPushed, setLastPushed] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The query string as last asked for here. App Router moves the address
  // bar (and useSearchParams) only once a navigation commits, so a change
  // right after another builds on this, never on the URL from before the
  // first one. It follows the URL whenever that changes (our own push
  // landing, or Back, Forward, a tab).
  const requested = useRef(current);
  useEffect(() => {
    requested.current = current;
  }, [current]);

  // The search box follows the address bar when it changes from outside
  // (Back, Forward, a tab, the Leads link), but not when it's our own push
  // landing, or while a search typed here is still on its way (that one
  // goes out on top of the new URL).
  if (current !== seen) {
    setSeen(current);
    setLastPushed(null);
    if (current !== lastPushed && !searching) setQ(urlQ);
  }

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  function go(params: URLSearchParams) {
    const next = params.toString();
    requested.current = next;
    setLastPushed(next);
    router.push(next ? `${pathname}?${next}` : pathname);
  }

  // A search still waiting on its debounce, cancelled. Returns what it was
  // going to send, so the change that cancelled it can carry it.
  function takePendingSearch(): string | null {
    if (!debounceRef.current) return null;
    clearTimeout(debounceRef.current);
    debounceRef.current = null;
    setSearching(false);
    return q;
  }

  // A notice from the last page (deleted, added) doesn't follow along. A
  // search typed a moment ago goes out in the same push, so the change
  // never drops it (or gets undone by it landing after).
  function updateParam(key: string, value: string) {
    const params = new URLSearchParams(requested.current);
    params.delete("deleted");
    params.delete("added");
    const pending = takePendingSearch();
    if (pending !== null) setOrDelete(params, "q", pending);
    setOrDelete(params, key, value);
    // A stage whose leads can't be on this tab (Lost, Not now or Not signed
    // on Active, Client anywhere but Clients) moves to the tab they're on,
    // so picking a stage never shows an empty list for no reason.
    if (key === "stage") {
      const tab = tabForStage(isPipelineStage(value) ? value : null, parseLeadTab(params.get("tab")));
      setOrDelete(params, "tab", tab === "active" ? "" : tab);
    }
    go(params);
  }

  function search(value: string) {
    setQ(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      setSearching(false);
      if ((new URLSearchParams(requested.current).get("q") ?? "") === value) return;
      updateParam("q", value);
    }, 300);
  }

  // Leaving the box (for a tab, a filter, anywhere) sends what was typed
  // right away, before whatever was clicked navigates: a search landing
  // after a tab click would take the tab back.
  function flushSearch() {
    const pending = takePendingSearch();
    if (pending !== null && (new URLSearchParams(requested.current).get("q") ?? "") !== pending) updateParam("q", pending);
  }

  const hasFilters = Boolean(searchParams.get("q") || searchParams.get("stage") || searchParams.get("owner") || searchParams.get("campaign"));

  return (
    <div className="mb-3.5 flex flex-wrap items-center gap-2">
      <input
        value={q}
        onChange={(e) => search(e.target.value)}
        onBlur={flushSearch}
        placeholder="Search name, company, email…"
        className="input w-full sm:w-[240px]"
        style={{ fontSize: "13px", padding: "7px 11px" }}
      />
      <select
        value={searchParams.get("stage") ?? ""}
        onChange={(e) => updateParam("stage", e.target.value)}
        className="input max-w-full flex-1 sm:w-[160px] sm:flex-none"
        style={{ fontSize: "13px", padding: "7px 11px" }}
        aria-label="Stage"
      >
        <option value="">Any stage</option>
        {PIPELINE_STAGES.map((s) => (
          <option key={s} value={s}>{PIPELINE_STAGE_LABEL[s]}</option>
        ))}
      </select>
      {showOwnerFilter && (
        <select
          value={searchParams.get("owner") ?? ""}
          onChange={(e) => updateParam("owner", e.target.value)}
          className="input max-w-full flex-1 sm:w-[160px] sm:flex-none"
          style={{ fontSize: "13px", padding: "7px 11px" }}
          aria-label="Owner"
        >
          <option value="">Anyone</option>
          <option value="mine">Mine</option>
          <option value="none">Unassigned</option>
          {owners.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
      )}
      {campaigns.length > 0 && (
        <select
          value={searchParams.get("campaign") ?? ""}
          onChange={(e) => updateParam("campaign", e.target.value)}
          className="input max-w-full flex-1 sm:w-[180px] sm:flex-none"
          style={{ fontSize: "13px", padding: "7px 11px" }}
          aria-label="Campaign"
        >
          <option value="">Any campaign</option>
          {campaigns.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      )}
      <select
        value={searchParams.get("sort") ?? ""}
        onChange={(e) => updateParam("sort", e.target.value)}
        className="input max-w-full flex-1 sm:w-[170px] sm:flex-none"
        style={{ fontSize: "13px", padding: "7px 11px" }}
        aria-label="Sort"
      >
        <option value="">Latest activity</option>
        <option value="lastcall">Last call first</option>
      </select>
      {hasFilters && (
        <button
          type="button"
          onClick={() => {
            takePendingSearch();
            setQ("");
            const params = new URLSearchParams();
            const tab = new URLSearchParams(requested.current).get("tab");
            if (tab) params.set("tab", tab);
            go(params);
          }}
          className="text-[12.5px] font-medium"
          style={{ color: "var(--ink-muted)" }}
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
