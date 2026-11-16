"use client";

import { useEffect, useRef, useState } from "react";
import { CardButton } from "./NextCard";
import s from "./contract.module.css";

const COPIED_MS = 1500;

// Copies a link (the client's sign link) for a NextCard's actions. When the
// browser won't write to the clipboard (blocked, or an older webview), the
// link shows in a field under the buttons, selected, to copy by hand.
// link is read at the click, so it can use the page's own origin.
export default function CopyLinkButton({ link, label = "Copy sign link" }: { link: () => string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(id);
  }, [copied]);

  // The link to copy by hand comes up selected.
  useEffect(() => {
    if (manual) field.current?.select();
  }, [manual]);

  function copy() {
    const url = link();
    setManual(null);
    // Started inside the click itself: browsers only allow it there.
    const write = navigator.clipboard?.writeText(url) ?? Promise.reject(new Error("No clipboard"));
    write.then(
      () => setCopied(true),
      () => setManual(url),
    );
  }

  return (
    <>
      <CardButton onClick={copy}>{copied ? "Copied" : label}</CardButton>
      {manual && (
        <label className={s.copyManual}>
          Copy the link from here:
          <input ref={field} readOnly value={manual} onFocus={(e) => e.currentTarget.select()} />
        </label>
      )}
    </>
  );
}
