import * as FileSystem from "expo-file-system/legacy";
import SherpaOnnx, { TTS } from "@siteed/sherpa-onnx.rn";
import { base64ToBytes, wavToPlaybackChunks } from "./mistral-cascade-socket";

// French fork addition: offline French voices (Piper/VITS via sherpa-onnx).
// Used to speak Mistral's replies: free, private, and works without network.

import { normalizeFrenchVoiceId, type FrenchVoiceId } from "./french-voice-ids";
export { normalizeFrenchVoiceId, type FrenchVoiceId };

export const FRENCH_VOICES: ReadonlyArray<{ id: FrenchVoiceId; archive: string; modelFile: string; labelFr: string; labelEn: string }> = [
  { id: "tom", archive: "vits-piper-fr_FR-tom-medium", modelFile: "fr_FR-tom-medium.onnx", labelFr: "Tom · voix d'homme", labelEn: "Tom · male voice" },
  { id: "siwis", archive: "vits-piper-fr_FR-siwis-medium", modelFile: "fr_FR-siwis-medium.onnx", labelFr: "Siwis · voix de femme", labelEn: "Siwis · female voice" },
];

export const FRENCH_VOICE_DOWNLOAD_MB = 64;
const ROOT = `${FileSystem.documentDirectory ?? ""}looi-tts/`;
const ARCHIVE_URL = (archive: string) => `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${archive}.tar.bz2`;

function voice(id: FrenchVoiceId) {
  return FRENCH_VOICES.find((item) => item.id === id) ?? FRENCH_VOICES[0];
}

function voiceDir(id: FrenchVoiceId): string {
  return `${ROOT}${voice(id).archive}/`;
}

export async function isFrenchVoiceInstalled(id: FrenchVoiceId): Promise<boolean> {
  const dir = voiceDir(id);
  const [model, tokens, data] = await Promise.all([
    FileSystem.getInfoAsync(`${dir}${voice(id).modelFile}`),
    FileSystem.getInfoAsync(`${dir}tokens.txt`),
    FileSystem.getInfoAsync(`${dir}espeak-ng-data`),
  ]);
  return Boolean(model.exists && (model as any).size > 1_000_000 && tokens.exists && data.exists);
}

let downloadPromise: Promise<void> | null = null;

/** Downloads (~64 MB) and installs one French voice. */
export function downloadFrenchVoice(id: FrenchVoiceId, onProgress?: (fraction: number) => void): Promise<void> {
  if (downloadPromise) return downloadPromise;
  downloadPromise = (async () => {
    if (await isFrenchVoiceInstalled(id)) return;
    const { archive } = voice(id);
    const archivePath = `${FileSystem.cacheDirectory ?? ""}${archive}.tar.bz2`;
    await FileSystem.makeDirectoryAsync(ROOT, { intermediates: true }).catch(() => undefined);
    const download = FileSystem.createDownloadResumable(ARCHIVE_URL(archive), archivePath, {}, (progress) => {
      if (progress.totalBytesExpectedToWrite > 0) onProgress?.(0.9 * (progress.totalBytesWritten / progress.totalBytesExpectedToWrite));
    });
    const result = await download.downloadAsync();
    if (!result || result.status < 200 || result.status >= 300) throw new Error(`Voice download failed (HTTP ${result?.status ?? "?"})`);
    await FileSystem.deleteAsync(voiceDir(id), { idempotent: true });
    const extracted = await SherpaOnnx.Archive.extractTarBz2(archivePath, ROOT);
    await FileSystem.deleteAsync(archivePath, { idempotent: true }).catch(() => undefined);
    if (!extracted.success) throw new Error(extracted.message || "Voice extraction failed");
    if (!(await isFrenchVoiceInstalled(id))) throw new Error("Voice files missing after extraction");
    onProgress?.(1);
  })().finally(() => { downloadPromise = null; });
  return downloadPromise;
}

let initializedVoice: FrenchVoiceId | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function ensureEngine(id: FrenchVoiceId): Promise<void> {
  if (initializedVoice === id) return;
  if (initializedVoice) {
    await TTS.release().catch(() => undefined);
    initializedVoice = null;
  }
  const result = await TTS.initialize({
    modelDir: voiceDir(id),
    ttsModelType: "vits",
    modelFile: voice(id).modelFile,
    tokensFile: "tokens.txt",
    dataDir: "espeak-ng-data",
    numThreads: 2,
  } as any);
  if (!result.success) throw new Error(result.error || "French voice engine failed to start");
  initializedVoice = id;
}

/** Text -> base64 PCM16 24 kHz chunks. Calls are serialized on the engine. */
export function synthesizeFrench(text: string, id: FrenchVoiceId, speed = 1): Promise<string[]> {
  const job = queue.then(async () => {
    await ensureEngine(id);
    const result = await TTS.generateSpeech(text, { playAudio: false, speakingRate: Math.min(1.5, Math.max(0.7, speed)), fileNamePrefix: "looi_fr_" });
    if (!result.success || !result.filePath) throw new Error("French speech generation failed");
    const uri = result.filePath.startsWith("file://") ? result.filePath : `file://${result.filePath}`;
    try {
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      return wavToPlaybackChunks(base64ToBytes(base64));
    } finally {
      void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
    }
  });
  queue = job.catch(() => undefined);
  return job;
}

export async function releaseFrenchVoice(): Promise<void> {
  if (!initializedVoice) return;
  initializedVoice = null;
  await TTS.release().catch(() => undefined);
}
