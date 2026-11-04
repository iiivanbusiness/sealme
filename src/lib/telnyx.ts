import { createPublicKey, verify } from "crypto";

// Telnyx signs every webhook with the account's Ed25519 key over
// "<timestamp>|<raw body>". The public key from Mission Control (Keys &
// Credentials) is the raw 32-byte key in base64; Node needs it wrapped
// as SPKI DER.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
// Older than this is treated as a replay.
const MAX_AGE_SECONDS = 300;

export function verifyTelnyxSignature(options: { body: string; signature: string | null; timestamp: string | null; publicKey: string; now?: number }): boolean {
  const { body, signature, timestamp, publicKey } = options;
  if (!signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (Math.abs(now - Number(timestamp)) > MAX_AGE_SECONDS) return false;
  try {
    const raw = Buffer.from(publicKey, "base64");
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(`${timestamp}|${body}`), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function isTelnyxConfigured(): boolean {
  return Boolean(process.env.TELNYX_API_KEY && process.env.TELNYX_PUBLIC_KEY);
}

// The shared SealMe number reps merge into their calls, in E.164.
export function sealmeNumber(): string | null {
  return process.env.TELNYX_PHONE_NUMBER || null;
}

const API = "https://api.telnyx.com/v2";

async function telnyx<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`Telnyx ${init?.method ?? "GET"} ${path.split("?")[0]} failed: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? {} : await res.json()) as T;
}

// A Call Control command on a live call (answer, speak, hangup...).
export async function callAction<T = { data?: { result?: string; recording_id?: string } }>(callControlId: string, action: string, body: Record<string, unknown> = {}): Promise<T> {
  return telnyx<T>(`/calls/${encodeURIComponent(callControlId)}/actions/${action}`, { method: "POST", body: JSON.stringify(body) });
}

// client_state rides along on every later event of the call; Telnyx wants
// it base64.
export function encodeClientState(state: object): string {
  return Buffer.from(JSON.stringify(state)).toString("base64");
}

export function decodeClientState<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as T;
  } catch {
    return null;
  }
}

type Recording = { id: string; download_urls?: { mp3?: string; wav?: string }; duration_millis?: number; call_control_id?: string };

// A fresh download link for a recording kept at Telnyx (links only last a
// few minutes, so this is fetched right before transcribing).
export async function recordingDownload(recordingId: string): Promise<{ url: string; seconds: number | null }> {
  const { data } = await telnyx<{ data: Recording }>(`/recordings/${encodeURIComponent(recordingId)}`);
  const url = data.download_urls?.mp3 ?? data.download_urls?.wav;
  if (!url) throw new Error("Telnyx has no download link for this recording");
  return { url, seconds: data.duration_millis ? Math.round(data.duration_millis / 1000) : null };
}

// When the recording.saved event doesn't name the recording.
export async function findRecordingId(callControlId: string): Promise<string | null> {
  const { data } = await telnyx<{ data: Recording[] }>(`/recordings?filter[call_control_id]=${encodeURIComponent(callControlId)}`);
  return data[0]?.id ?? null;
}

// Recordings aren't kept once a call is processed or dropped. A recording
// that's already gone counts as deleted.
export async function deleteRecording(recordingId: string): Promise<void> {
  const res = await fetch(`${API}/recordings/${encodeURIComponent(recordingId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } });
  if (!res.ok && res.status !== 404) throw new Error(`Telnyx recording delete failed: ${res.status} ${await res.text()}`);
}

// What a Call Control webhook carries, as far as SealMe reads it.
export type TelnyxEvent = {
  data?: {
    id?: string;
    event_type?: string;
    occurred_at?: string;
    payload?: {
      call_control_id?: string;
      call_leg_id?: string;
      call_session_id?: string;
      connection_id?: string;
      client_state?: string | null;
      direction?: string;
      from?: string;
      to?: string;
      state?: string;
      digit?: string;
      hangup_cause?: string;
      recording_id?: string;
      recording_started_at?: string;
      recording_ended_at?: string;
    };
  };
};

// The Voice API app the SealMe number is attached to: outbound calls go
// out through it. Read off the number once per server instance.
let connectionId: string | null = null;
export async function telnyxConnectionId(): Promise<string> {
  if (connectionId) return connectionId;
  const number = sealmeNumber();
  if (!number) throw new Error("TELNYX_PHONE_NUMBER isn't set");
  const { data } = await telnyx<{ data: { connection_id?: string }[] }>(`/phone_numbers?filter[phone_number]=${encodeURIComponent(number)}`);
  const id = data[0]?.connection_id;
  if (!id) throw new Error("The SealMe number isn't attached to a Voice API app");
  connectionId = id;
  return id;
}

// Places an outbound call through the SealMe app; returns its leg.
export async function dial(options: { to: string; from: string; clientState: object; timeoutSecs?: number; linkTo?: string; commandId?: string }): Promise<string> {
  const { data } = await telnyx<{ data: { call_control_id: string } }>("/calls", {
    method: "POST",
    body: JSON.stringify({
      connection_id: await telnyxConnectionId(),
      to: options.to,
      from: options.from,
      client_state: encodeClientState(options.clientState),
      timeout_secs: options.timeoutSecs ?? 30,
      ...(options.linkTo ? { link_to: options.linkTo } : {}),
      ...(options.commandId ? { command_id: options.commandId } : {}),
    }),
  });
  return data.call_control_id;
}

// A rep's own number becomes caller ID once they prove they hold it: Telnyx
// texts a code, the rep types it into SealMe.
export async function sendVerificationCode(phone: string): Promise<void> {
  await telnyx("/verified_numbers", { method: "POST", body: JSON.stringify({ phone_number: phone, verification_method: "sms" }) });
}

export async function confirmVerificationCode(phone: string, code: string): Promise<boolean> {
  const res = await fetch(`${API}/verified_numbers/${encodeURIComponent(phone)}/actions/verify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ verification_code: code }),
  });
  if (res.ok) return true;
  if (res.status === 400 || res.status === 404 || res.status === 422) return false;
  throw new Error(`Telnyx verify failed: ${res.status} ${await res.text()}`);
}

// Already confirmed on SealMe's Telnyx account, by whoever held the number
// before.
export async function isNumberVerified(phone: string): Promise<boolean> {
  const res = await fetch(`${API}/verified_numbers/${encodeURIComponent(phone)}`, { headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Telnyx verified number lookup failed: ${res.status} ${await res.text()}`);
  const { data } = (await res.json()) as { data?: { verified_at?: string | null } };
  return Boolean(data?.verified_at);
}

// Takes a number off the account's verified list, so it needs a fresh code
// before it's caller ID again. One that's already gone counts as removed.
export async function removeVerifiedNumber(phone: string): Promise<void> {
  const res = await fetch(`${API}/verified_numbers/${encodeURIComponent(phone)}`, { method: "DELETE", headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } });
  if (!res.ok && res.status !== 404) throw new Error(`Telnyx verified number delete failed: ${res.status} ${await res.text()}`);
}

type DetailRecord = { cost?: string | null; telnyx_session_id?: string | null };

async function detailRecords(recordType: string, filter: Record<string, string>): Promise<DetailRecord[]> {
  const params = new URLSearchParams({ "filter[record_type]": recordType, "filter[date_range]": "last_30_days", "page[size]": "50" });
  for (const [key, value] of Object.entries(filter)) params.set(`filter[${key}]`, value);
  const { data } = await telnyx<{ data?: DetailRecord[] }>(`/detail_records?${params}`);
  return data ?? [];
}

// What Telnyx billed for a call: every leg in its session (SealMe's line,
// the rep's phone, the client's), Call Control and the recording. Null
// until Telnyx has the records, which can take a while after hangup.
export async function telnyxCallCost(callControlId: string): Promise<number | null> {
  const [leg] = await detailRecords("sip-trunking", { call_control_id: callControlId });
  const session = leg?.telnyx_session_id;
  if (!session) return null;
  // One at a time: Telnyx answers parallel record queries with a 500 now
  // and then.
  let cost = 0;
  for (const type of ["call-control", "sip-trunking", "recording"]) {
    for (const r of await detailRecords(type, { telnyx_session_id: session })) cost += Number(r.cost) || 0;
  }
  return cost;
}
