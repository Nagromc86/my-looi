import * as SecureStore from "expo-secure-store";
import * as FileSystem from "expo-file-system/legacy";
import { CascadeServiceError, bytesToBase64, pcm16ToWav, type CascadeChatResult } from "./mistral-cascade-socket";

// French fork addition: Mistral (EU) API — free mode available at console.mistral.ai.
const MISTRAL_API_KEY_STORAGE_KEY = "looi.mistral-api-key.v1";
const MISTRAL_API = "https://api.mistral.ai/v1";
export const MISTRAL_API_KEY_URL = "https://console.mistral.ai/api-keys";
export const MISTRAL_CHAT_MODEL = "mistral-small-latest";
const TRANSCRIPTION_MODELS = ["voxtral-mini-latest", "voxtral-mini-transcribe-3"];

let cachedKey: string | null | undefined;

function normalizeKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim().replace(/\s+/g, "");
  return key || null;
}

export function validateMistralApiKey(value: string): string {
  const key = normalizeKey(value);
  if (!key || key.length < 20) throw new Error("Mistral API key must contain at least 20 characters");
  return key;
}

export async function getMistralApiKey(): Promise<string | null> {
  if (cachedKey !== undefined) return cachedKey;
  cachedKey = normalizeKey(await SecureStore.getItemAsync(MISTRAL_API_KEY_STORAGE_KEY));
  return cachedKey;
}

export async function hasMistralApiKey(): Promise<boolean> {
  return Boolean(await getMistralApiKey());
}

export async function saveMistralApiKey(value: string): Promise<void> {
  const key = validateMistralApiKey(value);
  await SecureStore.setItemAsync(MISTRAL_API_KEY_STORAGE_KEY, key);
  cachedKey = key;
}

export async function clearMistralApiKey(): Promise<void> {
  await SecureStore.deleteItemAsync(MISTRAL_API_KEY_STORAGE_KEY);
  cachedKey = null;
}

async function requireKey(): Promise<string> {
  const key = await getMistralApiKey();
  if (!key) throw new CascadeServiceError("Mistral API key is not configured", "invalid_key");
  return key;
}

async function failure(response: Response, what: string): Promise<CascadeServiceError> {
  const detail = (await response.text().catch(() => "")).slice(0, 240);
  const kind = response.status === 401 ? "invalid_key" : response.status === 429 ? "rate_limited" : "service_error";
  return new CascadeServiceError(`${what}: HTTP ${response.status} ${detail}`, kind);
}

/** Validates the key with a cheap call. */
export async function checkMistralApiKey(): Promise<{ ok: true } | { ok: false; reason: "invalid_key" | "network_error" | "service_error"; detail: string }> {
  const key = await requireKey();
  try {
    const response = await fetch(`${MISTRAL_API}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (response.ok) return { ok: true };
    const error = await failure(response, "Mistral models");
    return { ok: false, reason: error.kind === "invalid_key" ? "invalid_key" : "service_error", detail: error.message };
  } catch (error) {
    return { ok: false, reason: "network_error", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Voxtral transcription of a short 16 kHz utterance. */
export async function mistralTranscribe(pcm16k: Uint8Array, language: string): Promise<string> {
  const key = await requireKey();
  const uri = `${FileSystem.cacheDirectory ?? ""}looi-utterance-${Date.now()}.wav`;
  await FileSystem.writeAsStringAsync(uri, bytesToBase64(pcm16ToWav(pcm16k, 16_000)), { encoding: FileSystem.EncodingType.Base64 });
  try {
    let lastError: CascadeServiceError | null = null;
    for (const model of TRANSCRIPTION_MODELS) {
      const form = new FormData();
      form.append("model", model);
      if (language) form.append("language", language);
      form.append("file", { uri, name: "speech.wav", type: "audio/wav" } as any);
      const response = await fetch(`${MISTRAL_API}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      if (response.ok) {
        const body = (await response.json()) as { text?: string };
        return String(body.text ?? "");
      }
      lastError = await failure(response, `Voxtral (${model})`);
      // Only an unknown model is worth retrying with the next name.
      if (!(response.status === 400 || response.status === 404) || !/model/i.test(lastError.message)) throw lastError;
    }
    throw lastError ?? new CascadeServiceError("Voxtral transcription failed", "service_error");
  } finally {
    void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
  }
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("");
  }
  return "";
}

export async function mistralChat(request: { messages: Record<string, any>[]; tools: Record<string, any>[] }): Promise<CascadeChatResult> {
  const key = await requireKey();
  const response = await fetch(`${MISTRAL_API}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MISTRAL_CHAT_MODEL,
      messages: request.messages,
      ...(request.tools.length ? { tools: request.tools, tool_choice: "auto" } : {}),
      max_tokens: 400,
      temperature: 0.6,
    }),
  });
  if (!response.ok) throw await failure(response, "Mistral chat");
  const body = (await response.json()) as any;
  const message = body?.choices?.[0]?.message ?? {};
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls
      .filter((call: any) => call?.function?.name)
      .map((call: any, index: number) => ({
        id: String(call.id ?? `mistral-call-${Date.now()}-${index}`),
        name: String(call.function.name),
        arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}),
      }))
    : [];
  return { content: contentToText(message.content), toolCalls };
}
