import { DEEPGRAM_OPT_OUT } from "@/lib/recording-transcript";

export function isDeepgramConfigured(): boolean {
  return Boolean(process.env.DEEPGRAM_API_KEY);
}

// What Deepgram answered when it didn't transcribe, so a caller can tell
// audio it will never take from a hiccup worth sending again.
export class DeepgramError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`Deepgram transcription failed: ${status} ${body}`);
    this.name = "DeepgramError";
    this.status = status;
  }
}

// 400 is Deepgram saying the audio itself is corrupt or unsupported (and
// 413 too big): sending the same bytes again gets the same answer.
export function isUnusableAudio(err: unknown): boolean {
  return err instanceof DeepgramError && (err.status === 400 || err.status === 413);
}

type DeepgramWord = { word: string; punctuated_word?: string; start: number };
type DeepgramResponse = {
  results?: {
    channels?: { alternatives?: { words?: DeepgramWord[] }[] }[];
  };
};

// Speaker labels by channel index — the desktop app's local-capture audio is
// always encoded left = system audio (the other person, since that's what
// plays through the speakers), right = microphone (you). See
// desktop-app/src-tauri/native/audio_capture.swift.
const CHANNEL_LABELS = ["Client", "You"];

export type TranscriptWord = { text: string; start: number; speaker: string };

// The mic is recorded without echo cancellation, so on laptop speakers the
// client's words also reach the "You" channel a few tens of ms later. Kept
// under a second: a rep saying the same word back on purpose is slower.
const MIC_ECHO_WINDOW_SECONDS = 1.0;

function echoKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// Drops the "You" words that are the client's own words coming back through
// the mic: the same word (case and punctuation aside) starting 0 to 1 s
// after the client said it. Left in, every echoed word splits the client's
// sentence into "Client: we / You: we / Client: can / You: can ...".
export function dropMicEcho(words: TranscriptWord[]): TranscriptWord[] {
  const client = words
    .filter((w) => w.speaker === CHANNEL_LABELS[0])
    .map((w) => ({ start: w.start, key: echoKey(w.text) }))
    .sort((a, b) => a.start - b.start);
  return words.filter((w) => {
    if (w.speaker !== CHANNEL_LABELS[1]) return true;
    const key = echoKey(w.text);
    if (!key) return true;
    // First client word that could still be the one this echoes.
    let lo = 0;
    let hi = client.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (client[mid].start < w.start - MIC_ECHO_WINDOW_SECONDS) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < client.length && client[i].start <= w.start; i++) {
      if (client[i].key === key) return false;
    }
    return true;
  });
}

// Batch (prerecorded) transcription of a full call, recorded locally on the
// user's machine. Multichannel rather than diarized: the two speakers are
// already on separate channels (system audio vs. mic), so we get reliable
// "who said what" from the channel index instead of guessed diarization.
export async function transcribeWav(wavBytes: Buffer): Promise<string> {
  // Nova, not Whisper — Whisper (no forced language) transcribes mixed-
  // language calls far more accurately (verified side by side on the same
  // clip), but Deepgram spins up whisper-large on demand: a cold-start call
  // measured 318s, past even Vercel Hobby's 300s Fluid-compute ceiling, so
  // a cold start doesn't just run slow, Vercel kills it outright. Smaller
  // Whisper tiers (medium/small) come back fast but translate rather than
  // transcribe and hallucinate wrong numbers doing it (a test fee of "two
  // thousand" came back as "$9000" from whisper-medium, "$1,000" from
  // whisper-small) — worse than garbled text for a field that ends up in a
  // contract, since a plausible-looking wrong number is easy to miss on
  // review. Real customer calls aren't with Serbian clients, so
  // DEEPGRAM_LANGUAGE defaults to English now instead — override per
  // deployment if that's wrong for a given workspace. Doesn't fix a call
  // that code-switches languages mid-sentence (non-English segments still
  // get dropped or mangled) — no fast+accurate option for that exists in
  // Deepgram's current lineup; revisit if Vercel's function-duration
  // ceiling changes (e.g. a paid plan) or Deepgram's Whisper cold-start
  // improves.
  const language = process.env.DEEPGRAM_LANGUAGE || "en";
  const res = await fetch(`https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&multichannel=true&${DEEPGRAM_OPT_OUT}&language=${language}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      "Content-Type": "audio/wav",
    },
    body: new Uint8Array(wavBytes),
  });
  if (!res.ok) throw new DeepgramError(res.status, await res.text());

  const data = (await res.json()) as DeepgramResponse;
  const channels = data.results?.channels ?? [];

  const heardWords: TranscriptWord[] = [];
  channels.forEach((channel, i) => {
    const words = channel.alternatives?.[0]?.words ?? [];
    const speaker = CHANNEL_LABELS[i] ?? `Speaker ${i}`;
    for (const w of words) {
      heardWords.push({ text: w.punctuated_word ?? w.word, start: w.start, speaker });
    }
  });
  heardWords.sort((a, b) => a.start - b.start);
  const allWords = dropMicEcho(heardWords);
  if (allWords.length === 0) return "";

  const lines: string[] = [];
  let currentSpeaker = allWords[0].speaker;
  let currentWords: string[] = [];
  for (const w of allWords) {
    if (w.speaker !== currentSpeaker) {
      lines.push(`${currentSpeaker}: ${currentWords.join(" ")}`);
      currentSpeaker = w.speaker;
      currentWords = [];
    }
    currentWords.push(w.text);
  }
  if (currentWords.length) lines.push(`${currentSpeaker}: ${currentWords.join(" ")}`);
  return lines.join("\n");
}

// A single, single-speaker push-to-talk clip — e.g. a spoken correction
// given right after the call-recap plays (see voice-correction.ts). Simpler
// than transcribeWav on purpose: one channel, no diarization, just the
// plain transcript text. contentType is whatever the browser's
// MediaRecorder produced (typically audio/webm) — Deepgram accepts it
// directly, no client-side conversion to WAV needed.
export async function transcribeVoiceClip(audioBytes: Buffer, contentType: string): Promise<string> {
  // Same reasoning and same model/language choice as transcribeWav.
  const language = process.env.DEEPGRAM_LANGUAGE || "en";
  const res = await fetch(`https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&${DEEPGRAM_OPT_OUT}&language=${language}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      "Content-Type": contentType || "audio/webm",
    },
    body: new Uint8Array(audioBytes),
  });
  if (!res.ok) throw new DeepgramError(res.status, await res.text());

  const data = (await res.json()) as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } };
  return data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
}
