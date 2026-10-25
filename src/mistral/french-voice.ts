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

export const FRENCH_VOICE_DOWNLOAD_MB = 62;
const ROOT = `${FileSystem.documentDirectory ?? ""}looi-tts/`;
const ARCHIVE_URL = (archive: string) => `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${archive}.tar.bz2`;
// Pre-extracted files (see .github/workflows/prepare-voice-models.yml): no
// slow bzip2 extraction on the phone, and only the 6 small espeak-ng files
// French needs (724 KB instead of 19 MB).
const PREEXTRACTED_BASE_URL = "https://github.com/Nagromc86/my-looi/releases/download/voice-models-v1/";
const ESPEAK_FILES: ReadonlyArray<{ asset: string; path: string }> = [
  { asset: "espeak-phondata", path: "espeak-ng-data/phondata" },
  { asset: "espeak-phonindex", path: "espeak-ng-data/phonindex" },
  { asset: "espeak-phontab", path: "espeak-ng-data/phontab" },
  { asset: "espeak-intonations", path: "espeak-ng-data/intonations" },
  { asset: "espeak-fr_dict", path: "espeak-ng-data/fr_dict" },
  { asset: "espeak-lang-roa-fr", path: "espeak-ng-data/lang/roa/fr" },
];

function voice(id: FrenchVoiceId) {
  return FRENCH_VOICES.find((item) => item.id === id) ?? FRENCH_VOICES[0];
}

function voiceDir(id: FrenchVoiceId): string {
  return `${ROOT}${voice(id).archive}/`;
}

async function fileSize(uri: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(uri);
  return info.exists ? Number((info as any).size ?? 0) : 0;
}

export async function isFrenchVoiceInstalled(id: FrenchVoiceId): Promise<boolean> {
  const dir = voiceDir(id);
  const [model, tokens, phondata, dict] = await Promise.all([
    fileSize(`${dir}${voice(id).modelFile}`),
    fileSize(`${dir}tokens.txt`),
    fileSize(`${dir}espeak-ng-data/phondata`),
    fileSize(`${dir}espeak-ng-data/fr_dict`),
  ]);
  return model > 1_000_000 && tokens > 100 && phondata > 100_000 && dict > 10_000;
}

async function downloadTo(url: string, destination: string, onProgress?: (fraction: number) => void): Promise<void> {
  await FileSystem.makeDirectoryAsync(destination.slice(0, destination.lastIndexOf("/") + 1), { intermediates: true }).catch(() => undefined);
  const partial = `${destination}.part`;
  await FileSystem.deleteAsync(partial, { idempotent: true });
  const download = FileSystem.createDownloadResumable(url, partial, {}, (progress) => {
    if (progress.totalBytesExpectedToWrite > 0) onProgress?.(progress.totalBytesWritten / progress.totalBytesExpectedToWrite);
  });
  const result = await download.downloadAsync();
  if (!result || result.status < 200 || result.status >= 300) {
    await FileSystem.deleteAsync(partial, { idempotent: true }).catch(() => undefined);
    throw new Error(`HTTP ${result?.status ?? "?"} for ${url.slice(url.lastIndexOf("/") + 1)}`);
  }
  await FileSystem.deleteAsync(destination, { idempotent: true });
  await FileSystem.moveAsync({ from: partial, to: destination });
}

async function downloadPreextracted(id: FrenchVoiceId, onProgress?: (fraction: number) => void): Promise<void> {
  const dir = voiceDir(id);
  const { modelFile } = voice(id);
  // The model is ~60 MB; everything else is tiny.
  await downloadTo(`${PREEXTRACTED_BASE_URL}${modelFile}`, `${dir}${modelFile}`, (f) => onProgress?.(0.95 * f));
  await downloadTo(`${PREEXTRACTED_BASE_URL}${id}-tokens.txt`, `${dir}tokens.txt`);
  for (let i = 0; i < ESPEAK_FILES.length; i += 1) {
    await downloadTo(`${PREEXTRACTED_BASE_URL}${ESPEAK_FILES[i].asset}`, `${dir}${ESPEAK_FILES[i].path}`);
    onProgress?.(0.95 + 0.05 * ((i + 1) / ESPEAK_FILES.length));
  }
}

async function downloadArchive(id: FrenchVoiceId, onProgress?: (fraction: number) => void): Promise<void> {
  const { archive } = voice(id);
  const archivePath = `${FileSystem.cacheDirectory ?? ""}${archive}.tar.bz2`;
  await downloadTo(ARCHIVE_URL(archive), archivePath, (f) => onProgress?.(0.9 * f));
  await FileSystem.deleteAsync(voiceDir(id), { idempotent: true });
  const extracted = await SherpaOnnx.Archive.extractTarBz2(archivePath, ROOT);
  await FileSystem.deleteAsync(archivePath, { idempotent: true }).catch(() => undefined);
  if (!extracted.success) throw new Error(extracted.message || "Voice extraction failed");
}

let downloadPromise: Promise<void> | null = null;

/** Downloads (~62 MB) and installs one French voice. */
export function downloadFrenchVoice(id: FrenchVoiceId, onProgress?: (fraction: number) => void): Promise<void> {
  if (downloadPromise) return downloadPromise;
  downloadPromise = (async () => {
    if (await isFrenchVoiceInstalled(id)) return;
    await FileSystem.makeDirectoryAsync(ROOT, { intermediates: true }).catch(() => undefined);
    try {
      await downloadPreextracted(id, onProgress);
    } catch (error) {
      console.warn("[FrenchVoice] Direct download failed, falling back to the archive:", error);
      await downloadArchive(id, onProgress);
    }
    if (!(await isFrenchVoiceInstalled(id))) throw new Error("Voice files missing after download");
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
