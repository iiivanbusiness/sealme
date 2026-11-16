"use client";

import { useId, type ReactNode } from "react";
import Dialog from "./Dialog";
import s from "./contract.module.css";

// The document the way the client will get it. Pass a ContractPaper with
// mode="preview" as children; actions go in the header next to Close (the
// screen puts Download PDF there). notice shows a line under them, such as
// an action's error: a toast on the page can't be seen over this modal.

export type PreviewModalProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  // "This is what Harbor Media will see."
  subtitle?: string | null;
  actions?: ReactNode;
  // "Couldn't download the PDF. Try again."
  notice?: string | null;
  children: ReactNode;
};

export default function PreviewModal({ open, onClose, title = "Preview", subtitle, actions, notice, children }: PreviewModalProps) {
  const titleId = useId();
  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId} wide>
      <div className={s.previewH}>
        <div className={s.previewTitle}>
          <b id={titleId}>{title}</b>
          {subtitle && <span>{subtitle}</span>}
        </div>
        <div className={s.previewActions}>
          {actions}
          <button type="button" className={s.cbtn} data-autofocus="" onClick={onClose}>
            Close
          </button>
        </div>
        {notice && (
          <p className={s.previewNotice} role="alert">
            {notice}
          </p>
        )}
      </div>
      <div className={s.previewBody}>{children}</div>
    </Dialog>
  );
}
