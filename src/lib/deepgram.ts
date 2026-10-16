import { DEEPGRAM_OPT_OUT } from "@/lib/recording-transcript";

export function isDeepgramConfigured(): boolean {
  return Boolean(process.env.DEEPGRAM_API_KEY);
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
  if (!res.ok) throw new Error(`Deepgram transcription failed: ${res.status} ${await res.text()}`);

  const data = (await res.json()) as DeepgramResponse;
  const channels = data.results?.channels ?? [];

  const allWords: { text: string; start: number; speaker: string }[] = [];
  channels.forEach((channel, i) => {
    const words = channel.alternatives?.[0]?.words ?? [];
    const speaker = CHANNEL_LABELS[i] ?? `Speaker ${i}`;
    for (const w of words) {
      allWords.push({ text: w.punctuated_word ?? w.word, start: w.start, speaker });
    }
  });
  if (allWords.length === 0) return "";
  allWords.sort((a, b) => a.start - b.start);

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
  if (!res.ok) throw new Error(`Deepgram transcription failed: ${res.status} ${await res.text()}`);

  const data = (await res.json()) as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } };
  return data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
}
