// The iPhone app adds this to its user agent on every request
// (mobile-app/src-tauri/src/lib.rs), so the server, the proxy and the page
// can all tell it apart from a browser.
export const PHONE_APP_MARKER = "SealMeMobile";

export function isPhoneAppUserAgent(userAgent: string | null | undefined): boolean {
  return Boolean(userAgent?.includes(PHONE_APP_MARKER));
}

// The phone is for calls, notes, leads and how it's all going. Proposals and
// contracts (and the templates and clients behind them), the calendar and
// the analytics stay on the computer, so on the phone their pages send you to
// the Dashboard. Start a call (an upload, notes only on the phone) stays.
const COMPUTER_ONLY = ["/deals", "/clients", "/templates", "/calendar", "/analytics"];

export function phoneAppRedirect(pathname: string): string | null {
  if (pathname === "/deals/new") return null;
  return COMPUTER_ONLY.some((p) => pathname === p || pathname.startsWith(`${p}/`)) ? "/dashboard" : null;
}
