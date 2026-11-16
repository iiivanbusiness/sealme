// Small line icons for the contract screen, drawn in currentColor.

type IconProps = { size?: number; className?: string };

function base(size: number) {
  return { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
}

export function EyeIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  );
}

export function SendIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 12l16-8-6.5 16-2.6-6.9z" />
      <path d="M10.9 13.1L20 4" />
    </svg>
  );
}

export function CheckIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M5 12.5l4.2 4.2L19 7" />
    </svg>
  );
}

export function DownloadIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14" />
    </svg>
  );
}

export function RestoreIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 12a8 8 0 1 0 2.4-5.7" />
      <path d="M4 4v4.5h4.5" />
    </svg>
  );
}

export function LinkIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2" />
    </svg>
  );
}

export function HangUpIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3.3 13.6c4.8-4.1 12.6-4.1 17.4 0l-1.7 2.5c-.3.4-.8.5-1.2.3l-2.7-1.2c-.4-.2-.6-.6-.6-1v-1.7a12 12 0 0 0-5 0v1.7c0 .4-.2.8-.6 1l-2.7 1.2c-.4.2-.9.1-1.2-.3z" />
    </svg>
  );
}

export function PersonIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 19.5c1.2-3.2 3.9-5 7-5s5.8 1.8 7 5" />
    </svg>
  );
}

export function ChevronIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

// The round check in the terms list: green for a term heard on the call,
// blue for one the rep typed.
export function TermCheck({ edited }: { edited: boolean }) {
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="8" fill={edited ? "#0071e3" : "#1a9e46"} />
      <path d="M5.4 9.3l2.4 2.4 4.8-5" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
