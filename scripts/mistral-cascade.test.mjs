// Fork addition: behaviour tests for the Mistral cascade and the automatic
// Gemini -> Mistral failover, with fake transcription/chat/voice.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
function load(rel) {
  const output = ts.transpileModule(fs.readFileSync(path.join(root, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function("exports", "require", "module", output)(mod.exports, require, mod);
  return mod.exports;
}
const cascade = load("src/mistral/mistral-cascade-socket.ts");
const { MistralCascadeSocket, pcm16ToWav, parseWav, wavToPlaybackChunks, splitSentences, toSpeakableText, CascadeServiceError } = cascade;
const { FailoverRealtimeSocket, isQuotaClose } = load("src/mistral/failover-socket.ts");

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 20; i += 1) await tick(); };

// 20 ms of 16 kHz PCM16 at a given amplitude, base64.
function chunk(amplitude) {
  const bytes = new Uint8Array(320 * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 320; i += 1) view.setInt16(i * 2, Math.round(Math.sin(i / 3) * amplitude * 32767), true);
  return Buffer.from(bytes).toString("base64");
}
const append = (s, amplitude) => s.send(JSON.stringify({ type: "input_audio_buffer.append", audio: chunk(amplitude), sample_rate: 16000 }));
function speakInto(s, ms) {
  for (let t = 0; t < 400; t += 20) append(s, 0.001);       // quiet room
  for (let t = 0; t < ms; t += 20) append(s, 0.3);          // speech
  for (let t = 0; t < 900; t += 20) append(s, 0.001);       // silence -> end of turn
}

function makeCascade({ transcript = "Bonjour Louis", replies = [{ content: "Bonjour ! Comment vas-tu ?", toolCalls: [] }], handled = () => false, chatError = null } = {}) {
  const calls = { transcribe: 0, chat: [], synth: [] };
  const deps = {
    transcribe: async (pcm) => { calls.transcribe += 1; calls.lastPcmBytes = pcm.length; return transcript; },
    chat: async (req) => { calls.chat.push(JSON.parse(JSON.stringify(req))); if (chatError) throw chatError; return replies.shift() ?? { content: "D'accord.", toolCalls: [] }; },
    synthesize: async (text) => { calls.synth.push(text); return ["QUJD", "REVG"]; },
  };
  let clock = 1_000_000;
  const s = new MistralCascadeSocket({ deps, isLocallyHandledTranscript: handled, now: () => clock });
  const events = [];
  s.onmessage = (e) => events.push(JSON.parse(e.data));
  return { s, events, calls, types: () => events.map((e) => e.type), advance: (ms) => { clock += ms; } };
}

const sessionUpdate = JSON.stringify({ type: "session.update", session: {
  instructions: "Tu es LOOI. Réponds en français.",
  tools: [{ type: "function", name: "search_memory", description: "mem", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }],
} });

// --- audio helpers
{
  const pcm = new Uint8Array([0, 0, 0xff, 0x7f, 0x00, 0x80]);
  const parsed = parseWav(pcm16ToWav(pcm, 22050));
  assert.equal(parsed.sampleRate, 22050);
  assert.equal(parsed.samples.length, 3);
  assert.ok(parsed.samples[1] > 0.99 && parsed.samples[2] === -1);
  const chunks = wavToPlaybackChunks(pcm16ToWav(new Uint8Array(22050 * 2), 22050));
  const total = chunks.reduce((n, c) => n + Buffer.from(c, "base64").length, 0);
  assert.equal(total, 24000 * 2, "1 s at 22.05 kHz becomes 1 s at 24 kHz");
  assert.deepEqual(splitSentences("Oui. Il fait beau aujourd'hui à Paris ! Et toi, ça va ?"), ["Oui. Il fait beau aujourd'hui à Paris !", "Et toi, ça va ?"]);
  assert.equal(toSpeakableText("**Bonjour** [ici](http://x) - un\n- deux"), "Bonjour ici - un deux");
}

// --- a spoken exchange
{
  const c = makeCascade();
  await tick();
  c.s.send(sessionUpdate);
  await tick();
  assert.deepEqual(c.types(), ["session.created", "session.updated"]);
  c.events.length = 0;
  speakInto(c.s, 600);
  await settle();
  assert.deepEqual(c.types(), [
    "input_audio_buffer.speech_started",
    "input_audio_buffer.speech_stopped",
    "conversation.item.input_audio_transcription.completed",
    "response.created",
    "response.output_item.added",
    "response.output_audio_transcript.delta",
    "response.output_audio.delta",
    "response.output_audio.delta",
    "response.output_audio.done",
    "response.output_audio_transcript.done",
    "response.done",
  ]);
  assert.equal(c.events[2].transcript, "Bonjour Louis");
  assert.ok(c.calls.lastPcmBytes >= 16000 * 2 * 0.6, "whole utterance (with pre-roll) is transcribed");
  const req = c.calls.chat[0];
  assert.equal(req.messages[0].role, "system");
  assert.match(req.messages[0].content, /Réponds en français/);
  assert.deepEqual(req.messages[1], { role: "user", content: "Bonjour Louis" });
  assert.equal(req.tools[0].function.name, "search_memory");
  assert.equal("additionalProperties" in req.tools[0].function.parameters, false);
  assert.deepEqual(c.calls.synth, ["Bonjour ! Comment vas-tu ?"]);

  // LOOI's own voice is not picked up while it plays.
  c.events.length = 0;
  for (let t = 0; t < 600; t += 20) append(c.s, 0.3);
  assert.equal(c.types().includes("input_audio_buffer.speech_started"), false);
  // After playback, the next turn carries the history.
  c.advance(5000);
  c.events.length = 0;
  speakInto(c.s, 500);
  await settle();
  assert.equal(c.calls.chat[1].messages.at(-2).role, "assistant");
}

// --- noise blips are not utterances
{
  const c = makeCascade();
  await tick(); c.s.send(sessionUpdate); await tick(); c.events.length = 0;
  for (let t = 0; t < 400; t += 20) append(c.s, 0.001);
  for (let t = 0; t < 100; t += 20) append(c.s, 0.3);
  for (let t = 0; t < 900; t += 20) append(c.s, 0.001);
  await settle();
  assert.equal(c.calls.transcribe, 0);
}

// --- robot command: transcript only, no AI reply
{
  const c = makeCascade({ transcript: "Louis, avance", handled: (t) => /avance/.test(t) });
  await tick(); c.s.send(sessionUpdate); await tick(); c.events.length = 0;
  speakInto(c.s, 500);
  await settle();
  assert.ok(c.types().includes("conversation.item.input_audio_transcription.completed"));
  assert.equal(c.calls.chat.length, 0);
  assert.equal(c.types().includes("response.created"), false);
}

// --- tool round trip with the service
{
  const c = makeCascade({ transcript: "C'est quoi ma couleur préférée ?", replies: [
    { content: "", toolCalls: [{ id: "t1", name: "search_memory", arguments: "{\"query\":\"couleur\"}" }] },
    { content: "Ta couleur préférée est le bleu.", toolCalls: [] },
  ] });
  await tick(); c.s.send(sessionUpdate); await tick(); c.events.length = 0;
  speakInto(c.s, 500);
  await settle();
  const call = c.events.find((e) => e.type === "response.output_item.done");
  assert.equal(call.item.call_id, "t1");
  assert.equal(c.calls.chat.length, 1, "waits for the tool result");
  c.s.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: "t1", output: "{\"ok\":true,\"results\":[{\"memory\":\"bleu\"}]}" } }));
  c.s.send(JSON.stringify({ type: "response.create" }));
  await settle();
  const second = c.calls.chat[1].messages;
  assert.equal(second.at(-2).tool_calls[0].function.name, "search_memory");
  assert.deepEqual(second.at(-1), { role: "tool", name: "search_memory", tool_call_id: "t1", content: "{\"ok\":true,\"results\":[{\"memory\":\"bleu\"}]}" });
  assert.deepEqual(c.calls.synth, ["Ta couleur préférée est le bleu."]);
}

// --- look-here photo
{
  const c = makeCascade({ replies: [{ content: "Je vois une boîte de céréales.", toolCalls: [] }] });
  await tick(); c.s.send(sessionUpdate); await tick();
  c.s.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [
    { type: "input_text", text: "EXPLICIT LOOK-HERE SNAPSHOT" },
    { type: "input_image", image_url: "data:image/jpeg;base64,/9j/AAA=", detail: "high" },
  ] } }));
  c.s.send(JSON.stringify({ type: "response.create" }));
  await settle();
  assert.deepEqual(c.calls.chat[0].messages.at(-1).content, [
    { type: "text", text: "EXPLICIT LOOK-HERE SNAPSHOT" },
    { type: "image_url", image_url: "data:image/jpeg;base64,/9j/AAA=" },
  ]);
  assert.deepEqual(c.calls.synth, ["Je vois une boîte de céréales."]);
}

// --- errors are spoken, not silent
{
  const c = makeCascade({ chatError: new CascadeServiceError("HTTP 429", "rate_limited") });
  await tick(); c.s.send(sessionUpdate); await tick(); c.events.length = 0;
  speakInto(c.s, 500);
  await settle();
  assert.ok(c.types().includes("error"));
  assert.match(c.calls.synth[0], /réessaie dans une minute/);
}

// --- cancel during a reply (tap)
{
  let release;
  const c = makeCascade();
  c.s.options.deps.synthesize = () => new Promise((r) => { release = () => r(["QUJD"]); });
  await tick(); c.s.send(sessionUpdate); await tick(); c.events.length = 0;
  speakInto(c.s, 500);
  await settle();
  assert.ok(c.types().includes("response.created"));
  c.s.send(JSON.stringify({ type: "response.cancel" }));
  assert.equal(c.events.at(-1).type, "response.done");
  assert.equal(c.events.at(-1).response.status, "cancelled");
  release(); await settle();
  assert.equal(c.types().filter((t) => t === "response.output_audio.delta").length, 0, "nothing plays after cancel");
}

// --- failover: Gemini quota during a conversation
{
  assert.equal(isQuotaClose(1011, "RESOURCE_EXHAUSTED: You exceeded your current quota"), true);
  assert.equal(isQuotaClose(1008, "API key not valid"), false);
  class Fake {
    constructor(name) { this.name = name; this.readyState = 0; this.sent = []; this.onopen = this.onmessage = this.onerror = this.onclose = null; this.marked = false; }
    open() { this.readyState = 1; this.onopen?.({}); }
    send(d) { this.sent.push(JSON.parse(d)); }
    close() { this.closed = true; }
    emit(e) { this.onmessage?.({ data: JSON.stringify(e) }); }
    markSessionAnnounced() { this.marked = true; }
  }
  const made = [];
  let failedOver = null;
  const f = new FailoverRealtimeSocket({
    primary: () => { const s = new Fake("gemini"); made.push(s); return s; },
    secondary: () => { const s = new Fake("mistral"); made.push(s); return s; },
    onFailover: (d) => { failedOver = d; },
  });
  const events = []; let opened = 0; let closed = null;
  f.onopen = () => { opened += 1; };
  f.onmessage = (e) => events.push(JSON.parse(e.data).type);
  f.onclose = (e) => { closed = e; };
  made[0].open();
  f.send(sessionUpdate);
  made[0].emit({ type: "session.created" }); made[0].emit({ type: "session.updated" });
  made[0].emit({ type: "response.done" });
  made[0].onclose({ code: 1011, reason: "RESOURCE_EXHAUSTED quota" });
  assert.equal(closed, null, "the conversation does not end");
  assert.equal(failedOver.beforeSessionReady, false);
  assert.equal(made.length, 2);
  made[1].open();
  assert.equal(made[1].marked, true, "Mistral must not announce a second session");
  assert.equal(made[1].sent[0].type, "session.update", "configuration replayed");
  made[1].emit({ type: "session.updated" });
  made[1].emit({ type: "response.created" });
  assert.deepEqual(events, ["session.created", "session.updated", "response.done", "response.created"]);
  assert.equal(opened, 1);
  f.send(JSON.stringify({ type: "input_audio_buffer.append", audio: "AAAA", sample_rate: 16000 }));
  assert.equal(made[1].sent.at(-1).type, "input_audio_buffer.append");
  // A real error on the backup ends the conversation normally.
  made[1].onclose({ code: 1000, reason: "bye" });
  assert.equal(closed.reason, "bye");
}

// --- failover at connection time (quota already reached)
{
  class Fake { constructor() { this.readyState = 0; this.sent = []; } open() { this.onopen?.({}); } send(d) { this.sent.push(JSON.parse(d)); } close() {} emit(e) { this.onmessage?.({ data: JSON.stringify(e) }); } markSessionAnnounced() { this.marked = true; } }
  const made = [];
  const f = new FailoverRealtimeSocket({ primary: () => { const s = new Fake(); made.push(s); return s; }, secondary: () => { const s = new Fake(); made.push(s); return s; } });
  const events = [];
  f.onmessage = (e) => events.push(JSON.parse(e.data).type);
  made[0].open(); f.send(sessionUpdate);
  made[0].onclose({ code: 1011, reason: "Quota exceeded" });
  made[1].open();
  assert.notEqual(made[1].marked, true, "backup announces the session itself");
  made[1].emit({ type: "session.created" }); made[1].emit({ type: "session.updated" });
  assert.deepEqual(events, ["session.created", "session.updated"]);
}

// --- a bad Gemini key is not hidden by the failover
{
  class Fake { constructor() { this.readyState = 0; } open() { this.onopen?.({}); } send() {} close() {} }
  const made = [];
  const f = new FailoverRealtimeSocket({ primary: () => { const s = new Fake(); made.push(s); return s; }, secondary: () => { const s = new Fake(); made.push(s); return s; } });
  let closed = null; f.onclose = (e) => { closed = e; };
  made[0].open();
  made[0].onclose({ code: 1008, reason: "API key not valid" });
  assert.equal(made.length, 1);
  assert.equal(closed.code, 1008);
}

console.log("Mistral cascade + Gemini failover behaviour: all checks passed");
