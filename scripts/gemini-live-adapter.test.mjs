// Fork addition: behaviour tests for the Gemini Live adapter, against a fake
// Gemini server that follows the documented BidiGenerateContent protocol.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const file = path.join(root, "src/gemini/gemini-live-socket.ts");
const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} };
new Function("exports", "require", "module", output)(mod.exports, require, mod);
const { GeminiLiveSocket, toGeminiSchema, GEMINI_LIVE_URL } = mod.exports;

class FakeServerSocket {
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closed = null;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    FakeServerSocket.all.push(this);
  }
  open() { this.readyState = 1; this.onopen?.({}); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close(code, reason) { this.readyState = 3; this.closed = { code, reason }; }
  // Server -> client. Gemini sends JSON in binary frames: exercise that path.
  push(message) { this.onmessage?.({ data: new TextEncoder().encode(JSON.stringify(message)).buffer }); }
  drop(code, reason) { this.readyState = 3; this.onclose?.({ code, reason }); }
  last(key) { return [...this.sent].reverse().find((m) => key in m); }
}

function makeSession(extra = {}) {
  FakeServerSocket.all = [];
  const events = [];
  const handled = [];
  const socket = new GeminiLiveSocket({
    apiKey: "AIza-test-key-0123456789012345678901",
    model: "gemini-3.8-live",
    voiceName: "Puck",
    createSocket: (url) => new FakeServerSocket(url),
    isLocallyHandledTranscript: (t) => { handled.push(t); return /^(louis|looi)[, ]+(avance|recule|danse|regarde)/i.test(t); },
    ...extra,
  });
  let opened = false;
  socket.onopen = () => { opened = true; };
  socket.onmessage = (e) => events.push(JSON.parse(e.data));
  const server = FakeServerSocket.all[0];
  return { socket, server, events, handled, isOpened: () => opened, types: () => events.map((e) => e.type) };
}

const sessionUpdate = {
  type: "session.update",
  session: {
    instructions: "You are LOOI. Reply in French.",
    tools: [
      { type: "function", name: "search_memory", description: "Search memory", parameters: { type: "object", properties: { query: { type: "string", description: "q" } }, required: ["query"], additionalProperties: false } },
      { type: "function", name: "set_language_preferences", description: "lang", parameters: { type: "object", properties: { response_language: { type: "string", enum: ["ru", "uk", "en", "fr"] } }, required: ["response_language"], additionalProperties: false } },
    ],
  },
};

// 1. Connection + setup
{
  const s = makeSession();
  assert.ok(s.server.url.startsWith(GEMINI_LIVE_URL + "?key=AIza-test-key"));
  s.server.open();
  assert.equal(s.isOpened(), true);
  assert.equal(s.socket.readyState, 1);
  s.socket.send(JSON.stringify(sessionUpdate));
  const { setup } = s.server.sent[0];
  assert.equal(Object.keys(s.server.sent[0]).length, 1, "first message is only setup");
  assert.equal(setup.model, "models/gemini-3.8-live");
  assert.deepEqual(setup.generationConfig.responseModalities, ["AUDIO"]);
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Puck");
  assert.match(setup.systemInstruction.parts[0].text, /Reply in French/);
  assert.deepEqual(setup.inputAudioTranscription, {});
  assert.deepEqual(setup.outputAudioTranscription, {});
  assert.deepEqual(setup.contextWindowCompression, { slidingWindow: {} });
  assert.deepEqual(setup.sessionResumption, {});
  const fn = setup.tools[0].functionDeclarations;
  assert.equal(fn.length, 2);
  assert.equal(fn[0].parameters.type, "OBJECT");
  assert.equal(fn[0].parameters.properties.query.type, "STRING");
  assert.equal("additionalProperties" in fn[0].parameters, false);
  assert.deepEqual(fn[1].parameters.properties.response_language.enum, ["ru", "uk", "en", "fr"]);

  // Audio before setupComplete is dropped, not queued.
  s.socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA", sample_rate: 16000 }));
  assert.equal(s.server.sent.length, 1);
  s.server.push({ setupComplete: {} });
  assert.deepEqual(s.types(), ["session.created", "session.updated"]);
  s.socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA", sample_rate: 16000 }));
  assert.deepEqual(s.server.last("realtimeInput"), { realtimeInput: { audio: { data: "AAAA", mimeType: "audio/pcm;rate=16000" } } });
}

// 2. A normal spoken exchange
{
  const s = makeSession();
  s.server.open(); s.socket.send(JSON.stringify(sessionUpdate)); s.server.push({ setupComplete: {} });
  s.events.length = 0;
  s.server.push({ serverContent: { inputTranscription: { text: "Bonjour " } } });
  s.server.push({ serverContent: { inputTranscription: { text: "Louis, ça va ?" } } });
  s.server.push({ serverContent: { outputTranscription: { text: "Très bien" } } });
  s.server.push({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "QUJD" } }] } } });
  s.server.push({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "REVG" } }] } } });
  s.server.push({ serverContent: { generationComplete: true } });
  s.server.push({ serverContent: { turnComplete: true } });
  assert.deepEqual(s.types(), [
    "input_audio_buffer.speech_started",
    "input_audio_buffer.speech_stopped",
    "conversation.item.input_audio_transcription.completed",
    "response.created",
    "response.output_item.added",
    "response.output_audio_transcript.delta",
    "response.output_audio.delta",
    "response.output_audio.delta",
    "response.output_audio.done",
    "response.done",
  ]);
  assert.equal(s.events[2].transcript, "Bonjour Louis, ça va ?");
  assert.equal(s.events[6].delta, "QUJD");
  assert.equal(s.events.at(-1).response.status, "completed");
}

// 3. Robot command: the transcript is handled locally and Gemini's reply is dropped
{
  const s = makeSession();
  s.server.open(); s.socket.send(JSON.stringify(sessionUpdate)); s.server.push({ setupComplete: {} });
  s.events.length = 0;
  s.server.push({ serverContent: { inputTranscription: { text: "Louis, avance." } } });
  s.server.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "Tk9QRQ==" } }] }, outputTranscription: { text: "Je ne peux pas bouger" } } });
  s.server.push({ serverContent: { turnComplete: true } });
  assert.deepEqual(s.types(), [
    "input_audio_buffer.speech_started",
    "input_audio_buffer.speech_stopped",
    "conversation.item.input_audio_transcription.completed",
  ]);
  // Next normal turn plays again.
  s.server.push({ serverContent: { inputTranscription: { text: "Merci" } } });
  s.server.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "T0s=" } }] } } });
  assert.ok(s.types().includes("response.output_audio.delta"));
}

// 4. Barge-in: Gemini interrupts, playback must stop, response ends cancelled
{
  const s = makeSession();
  s.server.open(); s.socket.send(JSON.stringify(sessionUpdate)); s.server.push({ setupComplete: {} });
  s.server.push({ serverContent: { inputTranscription: { text: "Raconte une histoire" } } });
  s.server.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "QUJD" } }] } } });
  s.events.length = 0;
  s.server.push({ serverContent: { interrupted: true } });
  assert.deepEqual(s.types(), ["input_audio_buffer.speech_started", "response.done"]);
  assert.equal(s.events[1].response.status, "cancelled");
  // A stray turnComplete for the interrupted turn must not end the new utterance early.
  s.server.push({ serverContent: { inputTranscription: { text: "Non, stop, " } } });
  s.server.push({ serverContent: { turnComplete: true } });
  assert.equal(s.types().includes("conversation.item.input_audio_transcription.completed"), false);
  s.server.push({ serverContent: { inputTranscription: { text: "plutôt une blague" } } });
  s.server.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "QUJD" } }] } } });
  const done = s.events.find((e) => e.type === "conversation.item.input_audio_transcription.completed");
  assert.equal(done.transcript, "Non, stop, plutôt une blague");
}

// 5. Tool call round trip (memory search)
{
  const s = makeSession();
  s.server.open(); s.socket.send(JSON.stringify(sessionUpdate)); s.server.push({ setupComplete: {} });
  s.server.push({ serverContent: { inputTranscription: { text: "C'est quoi ma couleur préférée ?" } } });
  s.events.length = 0;
  s.server.push({ toolCall: { functionCalls: [{ id: "call-1", name: "search_memory", args: { query: "couleur préférée" } }] } });
  const call = s.events.find((e) => e.type === "response.output_item.done");
  assert.equal(call.item.type, "function_call");
  assert.equal(call.item.call_id, "call-1");
  assert.deepEqual(JSON.parse(call.item.arguments), { query: "couleur préférée" });
  assert.ok(s.types().includes("conversation.item.input_audio_transcription.completed"));
  s.socket.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "call-1", output: JSON.stringify({ ok: true, results: [{ memory: "bleu" }] }) } }));
  s.socket.send(JSON.stringify({ type: "response.create" }));
  assert.deepEqual(s.server.last("toolResponse"), { toolResponse: { functionResponses: [{ id: "call-1", name: "search_memory", response: { ok: true, results: [{ memory: "bleu" }] } }] } });
  assert.equal(s.server.sent.filter((m) => "clientContent" in m).length, 0, "no extra turn after a tool response");
  // Cancelled calls are never answered.
  s.server.push({ toolCall: { functionCalls: [{ id: "call-2", name: "search_memory", args: {} }] } });
  s.server.push({ toolCallCancellation: { ids: ["call-2"] } });
  const before = s.server.sent.length;
  s.socket.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "call-2", output: "{}" } }));
  assert.equal(s.server.sent.length, before);
}

// 6. Look-here photo: text + image become one clientContent turn
{
  const s = makeSession();
  s.server.open(); s.socket.send(JSON.stringify(sessionUpdate)); s.server.push({ setupComplete: {} });
  s.socket.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [
    { type: "input_text", text: "EXPLICIT LOOK-HERE SNAPSHOT" },
    { type: "input_image", image_url: "data:image/jpeg;base64,/9j/AAA=", detail: "high" },
  ] } }));
  assert.equal(s.server.sent.filter((m) => "clientContent" in m).length, 0, "buffered until response.create");
  s.socket.send(JSON.stringify({ type: "response.create" }));
  assert.deepEqual(s.server.last("clientContent"), { clientContent: { turns: [{ role: "user", parts: [
    { text: "EXPLICIT LOOK-HERE SNAPSHOT" },
    { inlineData: { mimeType: "image/jpeg", data: "/9j/AAA=" } },
  ] }], turnComplete: true } });
  // Failure path: response.create with instructions only.
  s.socket.send(JSON.stringify({ type: "response.create", response: { instructions: "Say you could not see it." } }));
  assert.deepEqual(s.server.last("clientContent").clientContent.turns[0].parts, [{ text: "Say you could not see it." }]);
}

// 7. Transparent resumption on goAway (connection lifetime ~10 min)
{
  const s = makeSession();
  s.server.open(); s.socket.send(JSON.stringify(sessionUpdate)); s.server.push({ setupComplete: {} });
  s.server.push({ sessionResumptionUpdate: { resumable: true, newHandle: "handle-42" } });
  let closedEvent = null;
  s.socket.onclose = (e) => { closedEvent = e; };
  s.server.push({ goAway: { timeLeft: "5s" } });
  assert.equal(FakeServerSocket.all.length, 2, "a new connection is opened");
  const second = FakeServerSocket.all[1];
  assert.deepEqual(s.server.closed, { code: 1000, reason: "resuming" });
  // Audio during the handover is dropped; a tool response is queued.
  s.socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA", sample_rate: 16000 }));
  second.open();
  assert.equal(second.sent[0].setup.sessionResumption.handle, "handle-42");
  assert.match(second.sent[0].setup.systemInstruction.parts[0].text, /LOOI/);
  const eventsBefore = s.events.length;
  second.push({ setupComplete: {} });
  assert.equal(s.events.length, eventsBefore, "no second session.updated (capture must not restart)");
  assert.equal(closedEvent, null, "the conversation never noticed");
  s.socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: "BBBB", sample_rate: 16000 }));
  assert.equal(second.last("realtimeInput").realtimeInput.audio.data, "BBBB");
  // Unexpected drop also resumes.
  second.drop(1011, "Internal error");
  assert.equal(FakeServerSocket.all.length, 3);
}

// 8. Fatal errors reach the service (bad key / quota)
{
  const s = makeSession();
  let closedEvent = null;
  s.socket.onclose = (e) => { closedEvent = e; };
  s.server.open(); s.socket.send(JSON.stringify(sessionUpdate));
  s.server.push({ sessionResumptionUpdate: { resumable: true, newHandle: "h" } });
  s.server.drop(1008, "API key not valid. Please pass a valid API key.");
  assert.equal(FakeServerSocket.all.length, 1, "no reconnect loop on a bad key");
  assert.equal(closedEvent.code, 1008);
  assert.match(closedEvent.reason, /API key not valid/);
}

// 9. Cancel (tap to interrupt / local command while generating)
{
  const s = makeSession();
  s.server.open(); s.socket.send(JSON.stringify(sessionUpdate)); s.server.push({ setupComplete: {} });
  s.server.push({ serverContent: { inputTranscription: { text: "Parle-moi de Paris" } } });
  s.server.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "QUJD" } }] } } });
  s.events.length = 0;
  s.socket.send(JSON.stringify({ type: "response.cancel" }));
  assert.deepEqual(s.types(), ["response.done"]);
  s.server.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "TEFURQ==" } }] } } });
  assert.deepEqual(s.types(), ["response.done"], "late audio is dropped");
  s.server.push({ serverContent: { turnComplete: true } });
  s.server.push({ serverContent: { inputTranscription: { text: "Et Lyon ?" } } });
  s.server.push({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "QUJD" } }] } } });
  assert.ok(s.types().includes("response.output_audio.delta"), "next turn plays");
}

// 10. Language change mid-session becomes a silent context note
{
  const s = makeSession();
  s.server.open(); s.socket.send(JSON.stringify(sessionUpdate)); s.server.push({ setupComplete: {} });
  s.socket.send(JSON.stringify({ type: "session.update", session: { ...sessionUpdate.session, instructions: "Reply in English." } }));
  const note = s.server.last("clientContent").clientContent;
  assert.equal(note.turnComplete, false);
  assert.match(note.turns[0].parts[0].text, /Reply in English/);
}

assert.deepEqual(toGeminiSchema({ type: "array", items: { type: "string" } }), { type: "ARRAY", items: { type: "STRING" } });
console.log("Gemini Live adapter behaviour: all checks passed");
