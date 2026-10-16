// Shared by the browser (a recording sent straight to Deepgram) and the
// server (the small-file fallback), so both give the same transcript.

// Diarized, single-track recordings: Deepgram tells speakers apart and
// numbers them from 0.
// mip_opt_out: Deepgram keeps a request only while it's processed and
// doesn't use it to improve its models (otherwise requests can be). The
// security page promises this, so every Deepgram request carries it.
export const DEEPGRAM_OPT_OUT = "mip_opt_out=true";

export const RECORDING_LISTEN_PARAMS = `model=nova-3&smart_format=true&punctuate=true&diarize=true&utterances=true&${DEEPGRAM_OPT_OUT}`;

// A two-channel phone recording (SealMe's own calls): each person is on
// their own channel, so turns are labeled by channel instead of guessed.
export const DUAL_CHANNEL_LISTEN_PARAMS = `model=nova-3&smart_format=true&punctuate=true&multichannel=true&utterances=true&${DEEPGRAM_OPT_OUT}`;

type Utterance = { speaker?: number; channel?: number; start?: number; transcript?: string };
type ListenResponse = {
  metadata?: { duration?: number };
  results?: { utterances?: Utterance[]; channels?: { alternatives?: { transcript?: string }[] }[] };
};

// One line per turn, "Speaker 1: ...", merging back-to-back utterances from
// the same person so a long answer reads as one turn.
export function transcriptFromListenResponse(data: ListenResponse): { transcript: string; seconds: number; turns: number } {
  const lines: { speaker: number; text: string }[] = [];
  for (const u of data.results?.utterances ?? []) {
    const text = u.transcript?.trim();
    if (!text) continue;
    const speaker = u.speaker ?? 0;
    const last = lines[lines.length - 1];
    if (last && last.speaker === speaker) last.text += ` ${text}`;
    else lines.push({ speaker, text });
  }
  const transcript = lines.length
    ? lines.map((l) => `Speaker ${l.speaker + 1}: ${l.text}`).join("\n")
    : (data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").trim();
  return { transcript, seconds: Math.round(data.metadata?.duration ?? 0), turns: lines.length };
}

// One line per turn, "Client: ..." / "Rep: ...", in the order they spoke.
export function transcriptFromChannels(data: ListenResponse, labels: string[]): { transcript: string; seconds: number; turns: number } {
  const utterances = [...(data.results?.utterances ?? [])].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const lines: { channel: number; text: string }[] = [];
  for (const u of utterances) {
    const text = u.transcript?.trim();
    if (!text) continue;
    const channel = u.channel ?? 0;
    const last = lines[lines.length - 1];
    if (last && last.channel === channel) last.text += ` ${text}`;
    else lines.push({ channel, text });
  }
  return {
    transcript: lines.map((l) => `${labels[l.channel] ?? `Speaker ${l.channel + 1}`}: ${l.text}`).join("\n"),
    seconds: Math.round(data.metadata?.duration ?? 0),
    turns: lines.length,
  };
}

// Zoom, Meet and Teams export captions as .vtt or .srt: drop the cue
// numbers and timings, turn "<v Name>text" into "Name: text", and join a
// speaker's consecutive lines.
export function transcriptFromCaptionFile(raw: string): string {
  const out: string[] = [];
  for (const block of raw.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => {
      const t = l.trim();
      return t && t !== "WEBVTT" && !t.startsWith("NOTE") && !/^\d+$/.test(t) && !t.includes("-->");
    });
    for (const line of lines) {
      const voice = line.match(/^<v\s+([^>]+)>(.*?)(<\/v>)?$/);
      const text = (voice ? `${voice[1].trim()}: ${voice[2]}` : line).replace(/<[^>]+>/g, "").trim();
      if (!text) continue;
      const prev = out[out.length - 1];
      const speaker = text.match(/^([^:]{1,40}):\s/)?.[1];
      if (prev && speaker && prev.startsWith(`${speaker}: `)) out[out.length - 1] = `${prev} ${text.slice(speaker.length + 2)}`;
      else out.push(text);
    }
  }
  return out.join("\n");
}
