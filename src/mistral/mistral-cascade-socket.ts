/**
 * MistralCascadeSocket — French fork addition.
 *
 * Mistral has no free speech-to-speech API, so LOOI chains three steps:
 *   local voice-activity detection -> Voxtral transcription (Mistral API)
 *   -> Mistral chat (tools, images) -> offline French voice (Piper, on phone).
 *
 * Like GeminiLiveSocket it exposes a WebSocket-shaped surface and speaks the
 * OpenAI Realtime event dialect, so the proven conversation service (capture,
 * playback, robot commands, memory tools, photos) is reused unchanged.
 *
 * Network/engine calls are injected (CascadeDeps) so the orchestration can be
 * unit-tested in Node.
 */

type Json = Record<string, any>;

export type CascadeToolCall = { id: string; name: string; arguments: string };
export type CascadeChatMessage = Json;
export type CascadeChatResult = { content: string; toolCalls: CascadeToolCall[] };

export class CascadeServiceError extends Error {
  constructor(message: string, readonly kind: "invalid_key" | "rate_limited" | "service_error") {
    super(message);
    this.name = "CascadeServiceError";
  }
}

export type CascadeDeps = {
  /** 16 kHz mono PCM16 little-endian -> text. */
  transcribe(pcm16k: Uint8Array): Promise<string>;
  chat(request: { messages: CascadeChatMessage[]; tools: Json[] }): Promise<CascadeChatResult>;
  /** Text -> base64 PCM16 24 kHz chunks ready for playback. */
  synthesize(text: string): Promise<string[]>;
};

export type MistralCascadeSocketOptions = {
  deps: CascadeDeps;
  isLocallyHandledTranscript?: (transcript: string) => boolean;
  log?: (event: string, details?: Record<string, unknown>) => void;
  /** Spoken when Mistral cannot be reached. */
  apologyText?: string;
  now?: () => number;
};

// ----------------------------------------------------------------- audio utils

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function pcm16Rms(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor(bytes.byteLength / 2);
  if (!count) return 0;
  let energy = 0;
  for (let i = 0; i < count; i += 1) {
    const sample = view.getInt16(i * 2, true) / 32768;
    energy += sample * sample;
  }
  return Math.sqrt(energy / count);
}

/** Wraps 16-bit mono PCM in a WAV container. */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i); };
  ascii(0, "RIFF"); view.setUint32(4, 36 + pcm.length, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, "data"); view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** Parses a mono/multi-channel PCM16 or float32 WAV into mono float samples. */
export function parseWav(bytes: Uint8Array): { sampleRate: number; samples: Float32Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAV file");
  let offset = 12;
  let format = 1, channels = 1, sampleRate = 16000, bits = 16;
  let dataOffset = -1, dataLength = 0;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      format = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataLength = Math.min(size, bytes.length - dataOffset);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error("WAV has no data chunk");
  const bytesPerSample = bits / 8;
  const frames = Math.floor(dataLength / (bytesPerSample * channels));
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const at = dataOffset + (frame * channels + channel) * bytesPerSample;
      if (format === 3 && bits === 32) sum += view.getFloat32(at, true);
      else if (bits === 16) sum += view.getInt16(at, true) / 32768;
      else if (bits === 32) sum += view.getInt32(at, true) / 2147483648;
      else if (bits === 8) sum += (view.getUint8(at) - 128) / 128;
    }
    samples[frame] = sum / channels;
  }
  return { sampleRate, samples };
}

export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const left = Math.min(samples.length - 1, Math.floor(position));
    const right = Math.min(samples.length - 1, left + 1);
    out[i] = samples[left] + (samples[right] - samples[left]) * (position - left);
  }
  return out;
}

export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] || 0));
    view.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return out;
}

/** WAV bytes -> base64 PCM16 24 kHz chunks of about half a second. */
export function wavToPlaybackChunks(wav: Uint8Array, chunkMs = 500): string[] {
  const { sampleRate, samples } = parseWav(wav);
  const pcm = floatToPcm16(resampleLinear(samples, sampleRate, 24_000));
  const chunkBytes = Math.max(2, Math.round((24_000 * chunkMs) / 1000) * 2);
  const chunks: string[] = [];
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) chunks.push(bytesToBase64(pcm.subarray(offset, offset + chunkBytes)));
  return chunks;
}

/** Splits a reply into sentences so the first one can be spoken sooner. */
export function splitSentences(text: string): string[] {
  const parts = text.replace(/\s+/g, " ").trim().match(/[^.!?…]+(?:[.!?…]+|$)/g) ?? [];
  const merged: string[] = [];
  for (const part of parts.map((p) => p.trim()).filter(Boolean)) {
    if (merged.length && merged[merged.length - 1].length < 25) merged[merged.length - 1] += ` ${part}`;
    else merged.push(part);
  }
  return merged;
}

/** Spoken replies should not contain Markdown. */
export function toSpeakableText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_#`>|~]+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toMistralTools(tools: unknown): Json[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool && tool.type === "function" && typeof tool.name === "string")
    .map((tool) => {
      const parameters = { ...(tool.parameters ?? { type: "object", properties: {} }) };
      delete parameters.additionalProperties;
      return { type: "function", function: { name: tool.name, description: tool.description ?? "", parameters } };
    });
}

function toMistralParts(content: unknown): Json[] {
  if (!Array.isArray(content)) return [];
  const parts: Json[] = [];
  for (const part of content) {
    if ((part?.type === "input_text" || part?.type === "text") && typeof part.text === "string" && part.text.trim()) {
      parts.push({ type: "text", text: part.text });
    } else if (part?.type === "input_image" && typeof part.image_url === "string") {
      parts.push({ type: "image_url", image_url: part.image_url });
    }
  }
  return parts;
}

// ------------------------------------------------------------------ the socket

const VAD = {
  minThreshold: 0.012,
  noiseMultiplier: 3.2,
  startMs: 160,
  endSilenceMs: 750,
  minSpeechMs: 350,
  maxUtteranceMs: 20_000,
  prerollMs: 350,
  playbackGuardMs: 450,
};
const MAX_HISTORY_MESSAGES = 24;
const MAX_TOOL_ROUNDS = 4;
const OPEN = 1;
const CLOSED = 3;

export class MistralCascadeSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: ((event: any) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  private readonly options: MistralCascadeSocketOptions;
  private readonly now: () => number;
  private instructions = "";
  private tools: Json[] = [];
  private announced = false;
  private closed = false;
  private history: Json[] = [];

  // VAD state
  private noiseFloor = 0.004;
  private speaking = false;
  private loudMs = 0;
  private silentMs = 0;
  private speechMs = 0;
  private preroll: Uint8Array[] = [];
  private prerollMs = 0;
  private utterance: Uint8Array[] = [];
  private utteranceMs = 0;
  private ignoreInputUntil = 0;

  // Pipeline state
  private busy = false;
  private generation = 0;
  private responseActive = false;
  private responseCounter = 0;
  private pendingParts: Json[] = [];
  private pendingToolCalls = new Map<string, string>();
  private toolOutputs = new Map<string, string>();
  private toolWaiter: (() => void) | null = null;

  constructor(options: MistralCascadeSocketOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    setTimeout(() => {
      if (this.closed) return;
      this.readyState = OPEN;
      this.onopen?.({});
    }, 0);
  }

  /** Session already configured elsewhere (used when taking over from Gemini). */
  markSessionAnnounced(): void {
    this.announced = true;
  }

  send(data: string): void {
    if (this.closed) return;
    let event: Json;
    try { event = JSON.parse(data); } catch { return; }
    this.handleClientEvent(event);
  }

  close(): void {
    this.closed = true;
    this.readyState = CLOSED;
    this.generation += 1;
    this.toolWaiter?.();
  }

  // ------------------------------------------------------------- client events

  private handleClientEvent(event: Json): void {
    switch (String(event.type ?? "")) {
      case "session.update": {
        const session = event.session ?? {};
        if (typeof session.instructions === "string") this.instructions = session.instructions;
        if (Array.isArray(session.tools)) this.tools = toMistralTools(session.tools);
        if (!this.announced) {
          this.announced = true;
          setTimeout(() => {
            if (this.closed) return;
            this.emit({ type: "session.created", session: { model: "mistral-cascade" } });
            this.emit({ type: "session.updated", session: { model: "mistral-cascade" } });
          }, 0);
        }
        return;
      }
      case "input_audio_buffer.append": {
        const audio = String(event.audio ?? "");
        const rate = Number(event.sample_rate) || 24_000;
        if (audio && rate === 16_000) this.feedAudio(base64ToBytes(audio));
        return;
      }
      case "conversation.item.create": {
        const item = event.item ?? {};
        if (item.type === "function_call_output") {
          const callId = String(item.call_id ?? "");
          if (this.pendingToolCalls.has(callId)) {
            this.toolOutputs.set(callId, typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? {}));
            if (this.toolOutputs.size >= this.pendingToolCalls.size) this.toolWaiter?.();
          }
          return;
        }
        if (item.type === "message") this.pendingParts.push(...toMistralParts(item.content));
        return;
      }
      case "response.create": {
        if (this.pendingToolCalls.size) { this.toolWaiter?.(); return; }
        const instructions = typeof event.response?.instructions === "string" ? event.response.instructions.trim() : "";
        const parts = this.pendingParts.splice(0);
        if (instructions) parts.push({ type: "text", text: instructions });
        if (!parts.length) return;
        this.pushHistory({ role: "user", content: parts });
        void this.runTurn(++this.generation);
        return;
      }
      case "response.cancel":
        this.cancel();
        return;
      default:
        return;
    }
  }

  private cancel(): void {
    this.generation += 1;
    this.busy = false;
    this.ignoreInputUntil = this.now();
    this.pendingToolCalls.clear();
    this.toolOutputs.clear();
    this.toolWaiter?.();
    if (this.responseActive) {
      this.responseActive = false;
      this.emit({ type: "response.done", response: { status: "cancelled", output: [] } });
    }
  }

  // ------------------------------------------------------------------ the VAD

  private feedAudio(chunk: Uint8Array): void {
    const ms = (chunk.byteLength / 2 / 16_000) * 1000;
    const now = this.now();
    if (this.busy || now < this.ignoreInputUntil) {
      this.resetVad();
      return;
    }
    const rms = pcm16Rms(chunk);
    const threshold = Math.max(VAD.minThreshold, this.noiseFloor * VAD.noiseMultiplier);

    if (!this.speaking) {
      this.preroll.push(chunk);
      this.prerollMs += ms;
      while (this.prerollMs > VAD.prerollMs && this.preroll.length > 1) {
        const dropped = this.preroll.shift()!;
        this.prerollMs -= (dropped.byteLength / 2 / 16_000) * 1000;
      }
      if (rms > threshold) {
        this.loudMs += ms;
        if (this.loudMs >= VAD.startMs) {
          this.speaking = true;
          this.utterance = this.preroll.splice(0);
          this.utteranceMs = this.prerollMs;
          this.prerollMs = 0;
          this.speechMs = this.loudMs;
          this.silentMs = 0;
          this.emit({ type: "input_audio_buffer.speech_started" });
        }
      } else {
        this.loudMs = 0;
        this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
      }
      return;
    }

    this.utterance.push(chunk);
    this.utteranceMs += ms;
    if (rms > threshold * 0.6) {
      this.silentMs = 0;
      this.speechMs += ms;
    } else {
      this.silentMs += ms;
    }
    if (this.silentMs >= VAD.endSilenceMs || this.utteranceMs >= VAD.maxUtteranceMs) this.endUtterance();
  }

  private resetVad(): void {
    this.speaking = false;
    this.loudMs = 0;
    this.silentMs = 0;
    this.speechMs = 0;
    this.preroll = [];
    this.prerollMs = 0;
    this.utterance = [];
    this.utteranceMs = 0;
  }

  private endUtterance(): void {
    const chunks = this.utterance;
    const speechMs = this.speechMs;
    this.resetVad();
    this.emit({ type: "input_audio_buffer.speech_stopped" });
    if (speechMs < VAD.minSpeechMs) return;
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const pcm = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { pcm.set(chunk, offset); offset += chunk.byteLength; }
    void this.handleUtterance(pcm, ++this.generation);
  }

  // ------------------------------------------------------------- the pipeline

  private isCurrent(generation: number): boolean {
    return !this.closed && generation === this.generation;
  }

  private async handleUtterance(pcm: Uint8Array, generation: number): Promise<void> {
    this.busy = true;
    let transcript = "";
    try {
      transcript = (await this.options.deps.transcribe(pcm)).trim();
    } catch (error) {
      this.log("mistral-transcribe-failed", { error: error instanceof Error ? error.message : String(error) });
      if (this.isCurrent(generation)) await this.apologize(generation, error);
      if (this.isCurrent(generation)) this.busy = false;
      return;
    }
    if (!this.isCurrent(generation)) return;
    if (!transcript) { this.busy = false; return; }
    this.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: `mistral-user-${generation}`,
      transcript,
    });
    let handledLocally = false;
    try { handledLocally = Boolean(this.options.isLocallyHandledTranscript?.(transcript)); } catch {}
    if (handledLocally) { this.busy = false; return; }
    this.pushHistory({ role: "user", content: transcript });
    await this.runTurn(generation);
  }

  private async runTurn(generation: number): Promise<void> {
    this.busy = true;
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const result = await this.options.deps.chat({
          messages: [{ role: "system", content: this.systemPrompt() }, ...this.history],
          tools: this.tools,
        });
        if (!this.isCurrent(generation)) return;
        if (!result.toolCalls.length) {
          await this.speak(toSpeakableText(result.content), generation);
          return;
        }
        this.pushHistory({
          role: "assistant",
          content: result.content ?? "",
          tool_calls: result.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })),
        });
        const outputs = await this.runTools(result.toolCalls, generation);
        if (!this.isCurrent(generation)) return;
        for (const call of result.toolCalls) {
          this.pushHistory({ role: "tool", name: call.name, tool_call_id: call.id, content: outputs.get(call.id) ?? "{\"ok\":false}" });
        }
      }
      await this.speak("Je n'ai pas réussi à finir, peux-tu reformuler ?", generation);
    } catch (error) {
      this.log("mistral-chat-failed", { error: error instanceof Error ? error.message : String(error) });
      if (this.isCurrent(generation)) await this.apologize(generation, error);
    } finally {
      if (this.isCurrent(generation)) this.busy = false;
    }
  }

  private runTools(calls: CascadeToolCall[], generation: number): Promise<Map<string, string>> {
    this.pendingToolCalls = new Map(calls.map((call) => [call.id, call.name]));
    this.toolOutputs = new Map();
    return new Promise((resolve) => {
      const finish = () => {
        this.toolWaiter = null;
        const outputs = this.toolOutputs;
        this.pendingToolCalls = new Map();
        this.toolOutputs = new Map();
        resolve(outputs);
      };
      this.toolWaiter = () => {
        if (!this.isCurrent(generation) || this.toolOutputs.size >= this.pendingToolCalls.size) finish();
      };
      for (const call of calls) {
        this.emit({ type: "response.output_item.done", item: { type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments || "{}" } });
      }
    });
  }

  private async speak(text: string, generation: number, rememberReply = true): Promise<void> {
    if (!text || !this.isCurrent(generation)) return;
    this.responseCounter += 1;
    const itemId = `mistral-assistant-${this.responseCounter}`;
    this.responseActive = true;
    this.emit({ type: "response.created", response: { id: `mistral-response-${this.responseCounter}` } });
    this.emit({ type: "response.output_item.added", item: { id: itemId, type: "message", role: "assistant" } });
    this.emit({ type: "response.output_audio_transcript.delta", delta: text, item_id: itemId });
    let audioMs = 0;
    const startedAt = this.now();
    try {
      for (const sentence of splitSentences(text)) {
        const chunks = await this.options.deps.synthesize(sentence);
        if (!this.isCurrent(generation)) return;
        for (const chunk of chunks) {
          audioMs += (Math.floor((chunk.length * 3) / 4) / 2 / 24_000) * 1000;
          this.emit({ type: "response.output_audio.delta", delta: chunk, item_id: itemId, content_index: 0 });
        }
      }
    } catch (error) {
      this.log("mistral-tts-failed", { error: error instanceof Error ? error.message : String(error) });
    }
    if (!this.isCurrent(generation)) return;
    // Do not listen to LOOI's own voice while it is still playing.
    this.ignoreInputUntil = startedAt + audioMs + VAD.playbackGuardMs;
    this.emit({ type: "response.output_audio.done", item_id: itemId });
    this.emit({ type: "response.output_audio_transcript.done", transcript: text, item_id: itemId });
    this.responseActive = false;
    this.emit({ type: "response.done", response: { status: "completed", output: [] } });
    if (rememberReply) this.pushHistory({ role: "assistant", content: text });
  }

  private async apologize(generation: number, error: unknown): Promise<void> {
    const kind = error instanceof CascadeServiceError ? error.kind : "service_error";
    this.emit({ type: "error", error: { code: kind, message: error instanceof Error ? error.message : String(error) } });
    const text = kind === "invalid_key"
      ? "Ma clé Mistral est refusée. Vérifie-la dans les réglages."
      : kind === "rate_limited"
        ? "Je suis un peu débordé, réessaie dans une minute."
        : this.options.apologyText ?? "Désolé, je n'arrive pas à réfléchir pour le moment.";
    await this.speak(text, generation, false);
  }

  private systemPrompt(): string {
    return `${this.instructions}\nYou are speaking out loud through a small robot: reply in plain spoken sentences, no Markdown, no lists, no emojis. Keep it short.`.trim();
  }

  private pushHistory(message: Json): void {
    this.history.push(message);
    if (this.history.length <= MAX_HISTORY_MESSAGES) return;
    // Trim from the front, but never start on a tool result or an assistant
    // tool-call without its results.
    let start = this.history.length - MAX_HISTORY_MESSAGES;
    while (start < this.history.length && this.history[start].role !== "user") start += 1;
    this.history = this.history.slice(start);
  }

  private emit(event: Json): void {
    try { this.onmessage?.({ data: JSON.stringify(event) }); } catch (error) {
      this.log("mistral-emit-failed", { type: event.type, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private log(event: string, details?: Record<string, unknown>): void {
    try { this.options.log?.(event, details); } catch {}
  }
}
