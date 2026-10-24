import * as SecureStore from "expo-secure-store";
import { DEFAULT_GEMINI_LIVE_MODEL } from "./gemini-live-socket";

// French fork addition: Gemini API key (free tier available at aistudio.google.com).
const GEMINI_API_KEY_STORAGE_KEY = "looi.gemini-api-key.v1";
const MIN_GEMINI_API_KEY_LENGTH = 30;
const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export const GEMINI_API_KEY_URL = "https://aistudio.google.com/apikey";

let cachedKey: string | null | undefined;

export class MissingGeminiApiKeyError extends Error {
  constructor() {
    super("Gemini API key is not configured");
    this.name = "MissingGeminiApiKeyError";
  }
}

function normalizeGeminiApiKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim().replace(/\s+/g, "");
  return key || null;
}

export function validateGeminiApiKey(value: string): string {
  const key = normalizeGeminiApiKey(value);
  if (!key || key.length < MIN_GEMINI_API_KEY_LENGTH) {
    throw new Error(`Gemini API key must contain at least ${MIN_GEMINI_API_KEY_LENGTH} characters`);
  }
  return key;
}

export async function getGeminiApiKey(): Promise<string | null> {
  if (cachedKey !== undefined) return cachedKey;
  cachedKey = normalizeGeminiApiKey(await SecureStore.getItemAsync(GEMINI_API_KEY_STORAGE_KEY));
  return cachedKey;
}

export async function hasGeminiApiKey(): Promise<boolean> {
  return Boolean(await getGeminiApiKey());
}

export async function saveGeminiApiKey(value: string): Promise<void> {
  const key = validateGeminiApiKey(value);
  await SecureStore.setItemAsync(GEMINI_API_KEY_STORAGE_KEY, key);
  cachedKey = key;
}

export async function clearGeminiApiKey(): Promise<void> {
  await SecureStore.deleteItemAsync(GEMINI_API_KEY_STORAGE_KEY);
  cachedKey = null;
}

export type GeminiKeyCheck =
  | { ok: true; liveModels: string[]; recommendedModel: string }
  | { ok: false; reason: "invalid_key" | "network_error" | "service_error"; detail: string };

/** Pick the best Live model: the standard Live model, then any non-preview Live model. */
export function chooseGeminiLiveModel(models: readonly string[]): string {
  if (models.includes(DEFAULT_GEMINI_LIVE_MODEL)) return DEFAULT_GEMINI_LIVE_MODEL;
  const score = (id: string) =>
    (/-live$/.test(id) ? 4 : 0) +
    (/extended-thinking/.test(id) ? -3 : 0) +
    (/preview/.test(id) ? -1 : 0) +
    (/native-audio/.test(id) ? 1 : 0);
  const sorted = [...models].sort((a, b) => score(b) - score(a) || b.localeCompare(a));
  return sorted[0] ?? DEFAULT_GEMINI_LIVE_MODEL;
}

/** Validates the key and lists models that support the Live (bidi) API. */
export async function checkGeminiApiKey(): Promise<GeminiKeyCheck> {
  const key = await getGeminiApiKey();
  if (!key) throw new MissingGeminiApiKeyError();
  let response: Response;
  try {
    response = await fetch(`${GEMINI_MODELS_URL}?pageSize=1000&key=${encodeURIComponent(key)}`);
  } catch (error) {
    return { ok: false, reason: "network_error", detail: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    const invalid = response.status === 400 || response.status === 401 || response.status === 403;
    return { ok: false, reason: invalid ? "invalid_key" : "service_error", detail: `HTTP ${response.status} ${detail}` };
  }
  const body = (await response.json().catch(() => ({}))) as {
    models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
  };
  const liveModels = (body.models ?? [])
    .filter((model) => (model.supportedGenerationMethods ?? []).includes("bidiGenerateContent"))
    .map((model) => String(model.name ?? "").replace(/^models\//, ""))
    .filter(Boolean);
  return { ok: true, liveModels, recommendedModel: chooseGeminiLiveModel(liveModels) };
}
