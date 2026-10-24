import { useUserStore } from "../store/user";
import { CascadeServiceError, MistralCascadeSocket } from "./mistral-cascade-socket";
import { mistralChat, mistralTranscribe } from "./mistral-api";
import { isFrenchVoiceInstalled, normalizeFrenchVoiceId, synthesizeFrench } from "./french-voice";
import { hasMistralApiKey } from "./mistral-api";

// French fork addition: binds the Mistral cascade to the phone (API, local
// Whisper fallback, offline French voice) and the user's preferences.

async function transcribeLocally(pcm16k: Uint8Array, language: string): Promise<string> {
  const view = new DataView(pcm16k.buffer, pcm16k.byteOffset, pcm16k.byteLength);
  const samples = new Array<number>(Math.floor(pcm16k.byteLength / 2));
  for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true) / 32768;
  const { sherpaVoiceAdapter } = await import("../voice/sherpa-adapter");
  return sherpaVoiceAdapter.transcribeSamplesWithLanguage(samples, 16_000, language as any);
}

export function createMistralSocket(options: {
  isLocallyHandledTranscript?: (transcript: string) => boolean;
  log?: (event: string, details?: Record<string, unknown>) => void;
}): MistralCascadeSocket {
  return new MistralCascadeSocket({
    isLocallyHandledTranscript: options.isLocallyHandledTranscript,
    log: options.log,
    deps: {
      transcribe: async (pcm16k) => {
        const language = useUserStore.getState().preferences.listeningLanguage;
        try {
          return await mistralTranscribe(pcm16k, language);
        } catch (error) {
          // A wrong key is reported; anything else (plan, quota, network)
          // falls back to the on-phone Whisper model so LOOI still listens.
          if (error instanceof CascadeServiceError && error.kind === "invalid_key") throw error;
          options.log?.("mistral-transcribe-local-fallback", { error: error instanceof Error ? error.message : String(error) });
          return transcribeLocally(pcm16k, language);
        }
      },
      chat: (request) => mistralChat(request),
      synthesize: (text) => {
        const preferences = useUserStore.getState().preferences;
        return synthesizeFrench(text, normalizeFrenchVoiceId(preferences.mistralVoiceId), preferences.ttsSpeed);
      },
    },
  });
}

/** True when Mistral can be used right now: key saved and French voice installed. */
export async function isMistralReady(): Promise<boolean> {
  const voiceId = normalizeFrenchVoiceId(useUserStore.getState().preferences.mistralVoiceId);
  const [key, voice] = await Promise.all([hasMistralApiKey(), isFrenchVoiceInstalled(voiceId)]);
  return key && voice;
}

// After a Gemini quota error, go straight to Mistral for a while instead of
// paying the failed-connection delay at every conversation start.
const GEMINI_QUOTA_COOLDOWN_MS = 15 * 60 * 1000;
let geminiQuotaUntil = 0;

export function markGeminiQuotaExhausted(now = Date.now()): void {
  geminiQuotaUntil = now + GEMINI_QUOTA_COOLDOWN_MS;
}

export function isGeminiQuotaCoolingDown(now = Date.now()): boolean {
  return now < geminiQuotaUntil;
}
