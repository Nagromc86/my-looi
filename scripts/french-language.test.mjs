// Fork addition: behaviour tests for the French language support.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cache = new Map();

function load(rel) {
  let file = path.resolve(root, rel);
  if (!file.endsWith(".ts")) file += ".ts";
  if (cache.has(file)) return cache.get(file);
  const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  cache.set(file, module.exports);
  const req = (spec) => {
    if (spec.startsWith(".")) return load(path.relative(root, path.resolve(path.dirname(file), spec)));
    if (spec.startsWith("@/")) return load(spec.slice(2));
    throw new Error(`unexpected import ${spec} in ${rel}`);
  };
  new Function("exports", "require", "module", output)(module.exports, req, module);
  return module.exports;
}

const { parseDrivingCommandTranscript } = load("src/voice/driving-command");
const { buildDrivingCommandGrammar, normalizeDrivingGrammarResult } = load("src/voice/driving-command-grammar");
const { parseExplicitRobotCommand, containsEmergencyStopWord } = load("src/voice/explicit-robot-command");
const { detectLanguageSwitchCommand, normalizeResponseLanguage } = load("src/language/response-language");
const { detectListeningLanguageSwitchCommand, normalizeListeningLanguage } = load("src/language/listening-language");
const { matchWakePhrase } = load("src/voice/wake-phrases");

// Driving mode (local recognizer)
const drive = (t) => parseDrivingCommandTranscript(t, "fr");
assert.deepEqual(drive("Avance"), { kind: "move", direction: "forward" });
assert.deepEqual(drive("allez, recule"), { kind: "move", direction: "backward" });
assert.deepEqual(drive("tourne à gauche"), { kind: "turn", direction: "left", degrees: 90 });
assert.deepEqual(drive("à droite"), { kind: "turn", direction: "right", degrees: 90 });
assert.deepEqual(drive("fais demi-tour"), { kind: "turn", direction: "right", degrees: 180 });
assert.deepEqual(drive("hoche la tête deux fois"), { kind: "gesture", gesture: "nod", count: 2 });
assert.deepEqual(drive("Danse !"), { kind: "dance" });
assert.deepEqual(drive("va dormir"), { kind: "sleep" });
assert.deepEqual(drive("Arrête-toi"), { kind: "stop" });
assert.deepEqual(drive("ça suffit"), { kind: "stop" });
assert.deepEqual(drive("c'est fini"), { kind: "exit" });
assert.equal(drive("raconte-moi une blague"), null);
// Universal STOP still works in French mode
assert.deepEqual(drive("stop"), { kind: "stop" });

// Vosk grammar
const grammar = buildDrivingCommandGrammar("fr");
const lookup = (t) => grammar.commandByPhrase.get(normalizeDrivingGrammarResult(t));
assert.deepEqual(lookup("allez avance"), { kind: "move", direction: "forward" });
assert.deepEqual(lookup("tourne à gauche"), { kind: "turn", direction: "left", degrees: 90 });
assert.deepEqual(lookup("arrête"), { kind: "stop" });
assert.ok(grammar.phrases.every((p) => !p.includes("'")), "no apostrophes in Vosk grammar");
assert.ok(grammar.phrases.length > 200);

// Conversation mode (addressed commands)
const cfg = { robotName: "LOOI", robotAddressAliases: ["Louis", "Robot"], listeningLanguage: "fr" };
const cmd = (t) => parseExplicitRobotCommand(t, cfg);
assert.deepEqual(cmd("Louis, avance."), { kind: "move", direction: "forward" });
assert.deepEqual(cmd("LOOI, recule un peu"), { kind: "move", direction: "backward" });
assert.deepEqual(cmd("Robot, tourne à droite"), { kind: "turn", direction: "right", degrees: 90 });
assert.deepEqual(cmd("Louis, va à gauche"), { kind: "turn", direction: "left", degrees: 90 });
assert.deepEqual(cmd("Louis, fais demi-tour"), { kind: "turn", direction: "right", degrees: 180 });
assert.deepEqual(cmd("Louis, hoche la tête trois fois"), { kind: "gesture", gesture: "nod", count: 3 });
assert.deepEqual(cmd("Louis, danse !"), { kind: "dance" });
assert.deepEqual(cmd("Louis, va dormir"), { kind: "sleep" });
assert.deepEqual(cmd("Louis, arrête-toi"), { kind: "move", direction: "stop" });
// Not orders: questions and nouns must stay conversation
assert.equal(cmd("Louis, tu dors ?"), null);
assert.equal(cmd("Louis, tu aimes la danse ?"), null);
assert.equal(cmd("Louis, raconte-moi une histoire"), null);
assert.equal(cmd("Avance"), null, "movement still requires the robot name");

// Emergency stop without name: short orders only
assert.equal(containsEmergencyStopWord("Arrête !", cfg), true);
assert.equal(containsEmergencyStopWord("Louis, arrête", cfg), true);
assert.equal(containsEmergencyStopWord("stop", cfg), true);
assert.equal(containsEmergencyStopWord("il n'arrête pas de pleuvoir aujourd'hui", cfg), false);
assert.equal(containsEmergencyStopWord("arrête de dire des bêtises", cfg), false);

// Language switching by voice
assert.equal(detectLanguageSwitchCommand("Parle en anglais"), "en");
assert.equal(detectLanguageSwitchCommand("Réponds en français s'il te plaît"), "fr");
assert.equal(detectLanguageSwitchCommand("Tu peux parler français ?"), "fr");
assert.equal(detectLanguageSwitchCommand("Говори по-французски"), "fr");
assert.equal(detectLanguageSwitchCommand("Parle-moi de la France"), null);
assert.equal(detectLanguageSwitchCommand("Comment on dit bonjour en anglais ?"), null);
assert.equal(detectListeningLanguageSwitchCommand("Écoute en français"), "fr");
assert.equal(detectListeningLanguageSwitchCommand("écoute, j'ai une question en anglais"), null);
assert.equal(normalizeResponseLanguage(undefined), "fr");
assert.equal(normalizeListeningLanguage("fr"), "fr");

// Wake name heard by a French transcription
assert.ok(matchWakePhrase("Louis, tu m'entends ?"));

console.log("French language behaviour: all checks passed");
