"use client";

import { useEffect, useRef, type ReactNode } from "react";
import s from "./contract.module.css";

// A modal on the browser's own <dialog>: it sits above everything, keeps
// Tab inside, and Escape closes it. A click on the dimmed backdrop closes
// it too. Focus starts on the element marked data-autofocus (else the first
// button) and goes back where it was on close.

export default function Dialog({
  open,
  onClose,
  labelledBy,
  label,
  wide = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy?: string;
  label?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  const downOnBackdrop = useRef(false);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    const first = dialog.querySelector<HTMLElement>("[data-autofocus]") ?? dialog.querySelector<HTMLElement>("button, [href], input, textarea, select");
    first?.focus();
    // The page behind doesn't scroll while the dialog is up.
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = overflow;
      if (dialog.open) dialog.close();
      before?.focus?.({ preventScroll: true });
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={wide ? `${s.dialog} ${s.dialogPreview}` : s.dialog}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : label}
      onCancel={(e) => {
        e.preventDefault();
        onCloseRef.current();
      }}
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onCloseRef.current();
        downOnBackdrop.current = false;
      }}
    >
      {open && <div className={s.dialogScroll}>{children}</div>}
    </dialog>
  );
}
