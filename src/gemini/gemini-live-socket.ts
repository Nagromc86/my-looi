/**
 * GeminiLiveSocket — French fork addition.
 *
 * A WebSocket-shaped adapter that lets the proven Realtime PCM conversation
 * service talk to the Gemini Live API without changing its state machine.
 *
 *   service --(OpenAI Realtime client events, JSON)--> adapter --> Gemini Live
 *   service <--(synthetic OpenAI Realtime server events)-- adapter <-- Gemini Live
 *
 * It also hides Gemini's ~10 minute connection lifetime: the session is
 * resumed transparently on a new connection (sessionResumption), and context
 * window compression removes the 15 minute audio-session limit.
 *
 * Pure TypeScript: only the global WebSocket is used, so it can be unit-tested
 * in Node with a fake server.
 */

export const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.8-live";

const MAX_RECONNECT_ATTEMPTS = 3;
const NORMAL_CLOSE = 1000;

type Json = Record<string, any>;
type SocketLike = {
  readyState: number;
  binaryType?: string;
  onopen: ((event: any) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: any) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type GeminiLiveSocketOptions = {
  apiKey: string;
  model?: string;
  voiceName?: string;
  /**
   * Returns true when a finished user utterance is handled locally (robot
   * movement, camera look-here). Gemini cannot cancel a generation, so the
   * adapter silently drops the model's spoken reply for that turn.
   */
  isLocallyHandledTranscript?: (transcript: string) => boolean;
  /** Test hook / custom transport. Defaults to the global WebSocket. */
  createSocket?: (url: string) => SocketLike;
  log?: (event: string, details?: Record<string, unknown>) => void;
};

const OPEN = 1;
const CLOSED = 3;

function decodeUtf8(bytes: Uint8Array): string {
  const Decoder = (globalThis as any).TextDecoder;
  if (typeof Decoder === "function") {
    try { return new Decoder("utf-8").decode(bytes); } catch {}
  }
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i++];
    let cp = b0;
    if (b0 >= 0xf0) cp = ((b0 & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else if (b0 >= 0xe0) cp = ((b0 & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else if (b0 >= 0xc0) cp = ((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f);
    out += String.fromCodePoint(cp);
  }
  return out;
}

function messageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return decodeUtf8(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return decodeUtf8(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  return String(data ?? "");
}

/** OpenAI JSON-schema tool parameters -> Gemini OpenAPI-subset schema. */
export function toGeminiSchema(schema: unknown): Json | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const source = schema as Json;
  const out: Json = {};
  if (typeof source.type === "string") out.type = source.type.toUpperCase();
  if (typeof source.description === "string") out.description = source.description;
  if (Array.isArray(source.enum)) out.enum = source.enum.map(String);
  if (Array.isArray(source.required) && source.required.length) out.required = source.required.map(String);
  if (source.properties && typeof source.properties === "object") {
    out.properties = {};
    for (const [name, value] of Object.entries(source.properties)) {
      const converted = toGeminiSchema(value);
      if (converted) out.properties[name] = converted;
    }
  }
  if (source.items) out.items = toGeminiSchema(source.items);
  return out;
}

function toGeminiTools(tools: unknown): Json[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const functionDeclarations = tools
    .filter((tool) => tool && tool.type === "function" && typeof tool.name === "string")
    .map((tool) => {
      const declaration: Json = { name: tool.name };
      if (typeof tool.description === "string") declaration.description = tool.description;
      const parameters = toGeminiSchema(tool.parameters);
      if (parameters && parameters.properties && Object.keys(parameters.properties).length) declaration.parameters = parameters;
      return declaration;
    });
  return functionDeclarations.length ? [{ functionDeclarations }] : undefined;
}

/** OpenAI message content parts -> Gemini parts. */
function toGeminiParts(content: unknown): Json[] {
  if (!Array.isArray(content)) return [];
  const parts: Json[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if ((part.type === "input_text" || part.type === "text") && typeof part.text === "string" && part.text.trim()) {
      parts.push({ text: part.text });
    } else if (part.type === "input_image" && typeof part.image_url === "string") {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.image_url);
      if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
  }
  return parts;
}

export class GeminiLiveSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = 0;
  onopen: ((event: any) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  private readonly options: GeminiLiveSocketOptions;
  private readonly model: string;
  private socket: SocketLike | null = null;
  private closedByClient = false;
  private announcedOpen = false;
  private announcedSession = false;
  private setupMessage: Json | null = null;
  private setupSent = false;
  private setupComplete = false;
  private resumptionHandle: string | null = null;
  private reconnectAttempts = 0;
  private reconnecting = false;
  private queuedWhileReconnecting: Json[] = [];

  // Conversation-turn state used to synthesize OpenAI-style events.
  private userText = "";
  private userSpeaking = false;
  private userItemCounter = 0;
  private responseActive = false;
  private responseCounter = 0;
  private outputAudioDone = false;
  private turnOpen = false;
  private suppressTurn = false;
  private suppressUntilOldTurnEnds = false;
  private ignoreNextTurnComplete = false;
  private pendingTurnParts: Json[] = [];
  private toolNames = new Map<string, string>();
  private lastSentWasToolResponse = false;

  constructor(options: GeminiLiveSocketOptions) {
    this.options = options;
    this.model = (options.model || DEFAULT_GEMINI_LIVE_MODEL).replace(/^models\//, "");
    this.connect();
  }

  // ---------------------------------------------------------------- transport

  private log(event: string, details?: Record<string, unknown>): void {
    try { this.options.log?.(event, details); } catch {}
  }

  private connect(): void {
    const url = `${GEMINI_LIVE_URL}?key=${encodeURIComponent(this.options.apiKey)}`;
    const socket = this.options.createSocket
      ? this.options.createSocket(url)
      : (new (globalThis as any).WebSocket(url) as SocketLike);
    try { socket.binaryType = "arraybuffer"; } catch {}
    this.socket = socket;
    this.setupSent = false;
    this.setupComplete = false;

    socket.onopen = (event) => {
      if (this.socket !== socket) return;
      if (this.setupMessage) this.sendSetup();
      if (!this.announcedOpen) {
        this.announcedOpen = true;
        this.readyState = OPEN;
        this.onopen?.(event);
      }
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let message: Json;
      try {
        message = JSON.parse(messageText(event.data));
      } catch (error) {
        this.log("gemini-message-parse-failed", { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      this.handleServerMessage(message);
    };
    socket.onerror = (event) => {
      if (this.socket !== socket) return;
      if (!this.reconnecting) this.onerror?.(event);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.handleTransportClose(event?.code ?? 1006, String(event?.reason ?? ""));
    };
  }

  private handleTransportClose(code: number, reason: string): void {
    this.socket = null;
    if (this.closedByClient) {
      this.readyState = CLOSED;
      return;
    }
    const fatal = /api.?key|permission|unauthori|quota|resource.?exhausted|billing|not found|invalid argument|unsupported/i.test(reason) || code === 1007 || code === 1008;
    const canResume = Boolean(this.resumptionHandle) && this.setupMessage && !fatal && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS;
    this.log("gemini-transport-closed", { code, reason, willResume: canResume });
    if (canResume) {
      this.reconnectAttempts += 1;
      this.beginReconnect();
      return;
    }
    this.readyState = CLOSED;
    this.onclose?.({ code, reason: reason || `Gemini Live closed (${code})` });
  }

  private beginReconnect(): void {
    this.reconnecting = true;
    // The interrupted generation is gone; make sure the service is not left
    // waiting for the end of a response that will never arrive.
    if (this.responseActive) this.finishResponse("cancelled", true);
    this.turnOpen = false;
    this.suppressTurn = false;
    this.suppressUntilOldTurnEnds = false;
    const old = this.socket;
    this.socket = null;
    if (old) {
      old.onopen = null; old.onmessage = null; old.onerror = null; old.onclose = null;
      try { old.close(NORMAL_CLOSE, "resuming"); } catch {}
    }
    this.connect();
  }

  private sendRaw(message: Json): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) return;
    socket.send(JSON.stringify(message));
  }

  private sendWhenReady(message: Json): void {
    if (this.reconnecting || !this.setupComplete) {
      this.queuedWhileReconnecting.push(message);
      return;
    }
    this.sendRaw(message);
  }

  private sendSetup(): void {
    if (!this.setupMessage || this.setupSent) return;
    const setup = {
      ...this.setupMessage,
      sessionResumption: this.resumptionHandle ? { handle: this.resumptionHandle } : {},
    };
    this.setupSent = true;
    this.sendRaw({ setup });
  }

  // ------------------------------------------------------------ WebSocket API

  send(data: string): void {
    let event: Json;
    try { event = JSON.parse(data); } catch { return; }
    this.handleClientEvent(event);
  }

  close(code = NORMAL_CLOSE, reason = "client"): void {
    this.closedByClient = true;
    this.readyState = CLOSED;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
      try { socket.close(code, reason); } catch {}
    }
  }

  // -------------------------------------------- OpenAI client events -> Gemini

  private handleClientEvent(event: Json): void {
    const type = String(event.type ?? "");
    switch (type) {
      case "session.update":
        this.applySessionUpdate(event.session ?? {});
        return;
      case "input_audio_buffer.append": {
        if (this.reconnecting || !this.setupComplete) return; // live audio is not worth queueing
        const audio = String(event.audio ?? "");
        if (!audio) return;
        const rate = Number(event.sample_rate) > 0 ? Number(event.sample_rate) : 24_000;
        this.sendRaw({ realtimeInput: { audio: { data: audio, mimeType: `audio/pcm;rate=${rate}` } } });
        return;
      }
      case "conversation.item.create": {
        const item = event.item ?? {};
        if (item.type === "function_call_output") {
          this.sendToolResponse(String(item.call_id ?? ""), item.output);
          return;
        }
        if (item.type === "message") {
          this.pendingTurnParts.push(...toGeminiParts(item.content));
        }
        return;
      }
      case "response.create": {
        const instructions = typeof event.response?.instructions === "string" ? event.response.instructions.trim() : "";
        const parts = this.pendingTurnParts.splice(0);
        if (instructions) parts.push({ text: instructions });
        if (!parts.length) {
          // After a toolResponse Gemini continues on its own; nothing to do.
          this.lastSentWasToolResponse = false;
          return;
        }
        // clientContent interrupts the current generation. Anything still
        // streaming from the old turn must not be played.
        if (this.turnOpen) this.suppressUntilOldTurnEnds = true;
        this.suppressTurn = false;
        this.lastSentWasToolResponse = false;
        this.sendWhenReady({ clientContent: { turns: [{ role: "user", parts }], turnComplete: true } });
        return;
      }
      case "response.cancel":
        // Gemini has no cancel: drop the rest of this generation locally.
        if (this.responseActive || this.turnOpen) {
          this.suppressTurn = true;
          if (this.responseActive) this.finishResponse("cancelled");
        }
        return;
      case "conversation.item.truncate":
        return; // Gemini keeps only what was actually streamed; nothing to do.
      default:
        return;
    }
  }

  private applySessionUpdate(session: Json): void {
    const instructions = typeof session.instructions === "string" ? session.instructions : "";
    const setup: Json = {
      model: `models/${this.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: this.options.voiceName || "Puck" } },
        },
      },
      systemInstruction: {
        parts: [{
          text: `${instructions}\nAlways answer out loud, in short natural spoken sentences.`.trim(),
        }],
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: { prefixPaddingMs: 300, silenceDurationMs: 800 },
      },
      contextWindowCompression: { slidingWindow: {} },
    };
    const tools = toGeminiTools(session.tools);
    if (tools) setup.tools = tools;

    const first = !this.setupMessage;
    this.setupMessage = setup;
    if (first) {
      this.sendSetup();
      return;
    }
    // Gemini cannot change its configuration mid-session. Future reconnects use
    // the new setup; the running session is told through the conversation,
    // unless a tool call is pending (its result already carries the change).
    if (this.toolNames.size === 0) {
      this.sendWhenReady({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: `[App settings changed] From now on follow these updated instructions:\n${instructions}` }] }],
          turnComplete: false,
        },
      });
    }
  }

  private sendToolResponse(callId: string, output: unknown): void {
    if (!callId || !this.toolNames.has(callId)) return; // cancelled or unknown call
    const name = this.toolNames.get(callId)!;
    this.toolNames.delete(callId);
    let response: Json;
    try {
      const parsed = typeof output === "string" ? JSON.parse(output) : output;
      response = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { result: parsed };
    } catch {
      response = { result: String(output ?? "") };
    }
    this.lastSentWasToolResponse = true;
    this.sendWhenReady({ toolResponse: { functionResponses: [{ id: callId, name, response }] } });
  }

  // -------------------------------------------- Gemini server -> OpenAI events

  private emit(event: Json): void {
    try {
      this.onmessage?.({ data: JSON.stringify(event) });
    } catch (error) {
      this.log("gemini-emit-failed", { type: event.type, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private handleServerMessage(message: Json): void {
    if (message.setupComplete !== undefined) {
      this.setupComplete = true;
      const wasReconnecting = this.reconnecting;
      this.reconnecting = false;
      const queued = this.queuedWhileReconnecting.splice(0);
      for (const item of queued) this.sendRaw(item);
      if (wasReconnecting) {
        this.log("gemini-session-resumed", { attempts: this.reconnectAttempts });
        this.reconnectAttempts = 0;
      }
      if (!this.announcedSession) {
        this.announcedSession = true;
        this.emit({ type: "session.created", session: { model: this.model } });
        this.emit({ type: "session.updated", session: { model: this.model } });
      }
      return;
    }
    if (message.sessionResumptionUpdate) {
      const update = message.sessionResumptionUpdate;
      if (update.resumable && typeof update.newHandle === "string" && update.newHandle) {
        this.resumptionHandle = update.newHandle;
      }
      return;
    }
    if (message.goAway) {
      this.log("gemini-go-away", { timeLeft: message.goAway.timeLeft, resumable: Boolean(this.resumptionHandle) });
      if (this.resumptionHandle && !this.closedByClient) {
        this.reconnectAttempts += 1;
        this.beginReconnect();
      }
      return;
    }
    if (message.toolCall) {
      this.handleToolCall(message.toolCall);
      return;
    }
    if (message.toolCallCancellation) {
      for (const id of message.toolCallCancellation.ids ?? []) this.toolNames.delete(String(id));
      return;
    }
    if (message.serverContent) {
      this.handleServerContent(message.serverContent);
      return;
    }
    if (message.error) {
      this.emit({ type: "error", error: { code: message.error.code ?? message.error.status, message: message.error.message } });
    }
  }

  private handleServerContent(content: Json): void {
    const inputText = content.inputTranscription?.text;
    if (typeof inputText === "string" && inputText) {
      this.userText += inputText;
      if (!this.userSpeaking && !this.responseActive) {
        this.userSpeaking = true;
        this.emit({ type: "input_audio_buffer.speech_started" });
      }
    }

    if (content.interrupted) {
      this.ignoreNextTurnComplete = true;
      this.turnOpen = false;
      this.suppressTurn = false;
      this.suppressUntilOldTurnEnds = false;
      if (this.responseActive) {
        // Barge-in: the service stops and clears playback on speech_started.
        this.userSpeaking = true;
        this.emit({ type: "input_audio_buffer.speech_started" });
        this.finishResponse("cancelled");
      }
    }

    const parts: Json[] = Array.isArray(content.modelTurn?.parts) ? content.modelTurn.parts : [];
    const outputText = content.outputTranscription?.text;
    const hasModelOutput = parts.length > 0 || (typeof outputText === "string" && outputText.length > 0);
    if (hasModelOutput) {
      this.ignoreNextTurnComplete = false;
      this.onModelOutputStarting();
      if (this.isDropping()) {
        // Locally handled or cancelled turn: swallow the model's reply.
      } else {
        for (const part of parts) {
          const data = part?.inlineData?.data;
          const mimeType = String(part?.inlineData?.mimeType ?? "");
          if (typeof data === "string" && data && (!mimeType || mimeType.startsWith("audio/"))) {
            this.ensureResponse();
            this.emit({ type: "response.output_audio.delta", delta: data, item_id: this.currentItemId(), content_index: 0 });
          }
        }
        if (typeof outputText === "string" && outputText) {
          this.ensureResponse();
          this.emit({ type: "response.output_audio_transcript.delta", delta: outputText, item_id: this.currentItemId() });
        }
      }
    }

    if (content.generationComplete && this.responseActive && !this.outputAudioDone) {
      this.outputAudioDone = true;
      this.emit({ type: "response.output_audio.done", item_id: this.currentItemId() });
    }

    if (content.turnComplete) {
      if (this.ignoreNextTurnComplete && !this.responseActive) {
        this.ignoreNextTurnComplete = false;
        return;
      }
      this.flushUserTranscript();
      if (this.responseActive) this.finishResponse("completed");
      this.turnOpen = false;
      this.suppressTurn = false;
      this.suppressUntilOldTurnEnds = false;
    }
  }

  private handleToolCall(toolCall: Json): void {
    this.ignoreNextTurnComplete = false;
    this.flushUserTranscript();
    const calls: Json[] = Array.isArray(toolCall.functionCalls) ? toolCall.functionCalls : [];
    const items = calls
      .filter((call) => call && typeof call.name === "string")
      .map((call, index) => {
        const id = String(call.id ?? `gemini-call-${Date.now()}-${index}`);
        this.toolNames.set(id, call.name);
        return { type: "function_call", call_id: id, name: call.name, arguments: JSON.stringify(call.args ?? {}) };
      });
    if (this.responseActive) {
      if (!this.outputAudioDone) {
        this.outputAudioDone = true;
        this.emit({ type: "response.output_audio.done", item_id: this.currentItemId() });
      }
      this.emit({ type: "response.done", response: { status: "completed", output: items } });
      this.responseActive = false;
    }
    this.turnOpen = false;
    for (const item of items) this.emit({ type: "response.output_item.done", item });
  }

  private isDropping(): boolean {
    return this.suppressTurn || this.suppressUntilOldTurnEnds;
  }

  /** Called on the first piece of model output for a turn. */
  private onModelOutputStarting(): void {
    if (this.turnOpen) return;
    this.turnOpen = true;
    const handledLocally = this.flushUserTranscript();
    if (handledLocally) this.suppressTurn = true;
  }

  /** Emits the finished user utterance. Returns true if it was handled locally. */
  private flushUserTranscript(): boolean {
    const transcript = this.userText.trim();
    this.userText = "";
    const wasSpeaking = this.userSpeaking;
    this.userSpeaking = false;
    if (!transcript) {
      if (wasSpeaking) this.emit({ type: "input_audio_buffer.speech_stopped" });
      return false;
    }
    this.userItemCounter += 1;
    this.emit({ type: "input_audio_buffer.speech_stopped" });
    this.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: `gemini-user-${this.userItemCounter}`,
      transcript,
    });
    try {
      return Boolean(this.options.isLocallyHandledTranscript?.(transcript));
    } catch {
      return false;
    }
  }

  private currentItemId(): string {
    return `gemini-assistant-${this.responseCounter}`;
  }

  private ensureResponse(): void {
    if (this.responseActive) return;
    this.responseActive = true;
    this.outputAudioDone = false;
    this.responseCounter += 1;
    this.emit({ type: "response.created", response: { id: `gemini-response-${this.responseCounter}` } });
    this.emit({
      type: "response.output_item.added",
      item: { id: this.currentItemId(), type: "message", role: "assistant" },
    });
  }

  /**
   * Ends the synthetic response. Audio-done lets queued playback drain
   * naturally; it is skipped on barge-in/cancel because the service has
   * already stopped and cleared playback itself.
   */
  private finishResponse(status: "completed" | "cancelled", drainPlayback = status === "completed"): void {
    if (!this.responseActive) return;
    if (drainPlayback && !this.outputAudioDone) {
      this.outputAudioDone = true;
      this.emit({ type: "response.output_audio.done", item_id: this.currentItemId() });
    }
    this.responseActive = false;
    this.emit({ type: "response.done", response: { status, output: [] } });
  }
}
