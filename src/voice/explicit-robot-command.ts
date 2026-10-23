import type { CustomVoiceCommandAction, CustomVoiceCommandMap, CustomVoiceCommandPhrase, VoiceCommandLanguage } from "../store/user";
export type ExplicitRobotCommand =
  | { kind: "move"; direction: "forward" | "backward" | "stop" }
  | { kind: "turn"; direction: "left" | "right"; degrees: 90 | 180 }
  | { kind: "sleep" }
  | { kind: "dance" }
  | { kind: "gesture"; gesture: "nod"; count: number };

export type ExplicitRobotCommandConfig = {
  robotName?: string;
  robotAddressAliases?: readonly string[];
  robotAddressRecognitionAliases?: readonly string[];
  listeningLanguage?: VoiceCommandLanguage;
  customVoiceCommands?: CustomVoiceCommandMap;
};

// Narrow STT recovery aliases are accepted only in the address position and
// still require the remainder to parse as a deterministic physical command.
const BUILTIN_ADDRESS_ALIASES = ["луи", "луй", "луни", "луї", "луі", "лу и", "looi", "макс", "max", "робот", "robot", "уи", "уй", "рога", "louis", "louie", "loui", "loulou"];

function normalizeMatchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/ё/g, "е").replace(/[’'`]/g, "").replace(/[^a-zà-ÿœæа-яіїєґ0-9\s]/giu, " ").replace(/\s+/g, " ").trim();
}

function configuredAddresses(config?: ExplicitRobotCommandConfig): string[] {
  return [config?.robotName ?? "Луи", ...(config?.robotAddressAliases ?? []), ...(config?.robotAddressRecognitionAliases ?? []), ...BUILTIN_ADDRESS_ALIASES]
    .map(normalizeMatchText).filter(Boolean).sort((a, b) => b.length - a.length);
}

function splitAddressedCommand(text: string, config?: ExplicitRobotCommandConfig): { address: string; command: string } | null {
  const normalized = normalizeMatchText(normalizeKnownGluedRobotAddress(text));
  for (const address of configuredAddresses(config)) {
    if (normalized === address) return null;
    if (normalized.startsWith(`${address} `)) return { address, command: normalized.slice(address.length).trim() };
  }
  return null;
}

export function hasExplicitRobotAddress(text: string, config?: ExplicitRobotCommandConfig): boolean {
  return splitAddressedCommand(text, config) !== null;
}

/** Return the normalized command remainder only when the utterance starts with an accepted robot address. */
export function getExplicitRobotAddressedCommand(text: string, config?: ExplicitRobotCommandConfig): string | null {
  return splitAddressedCommand(text, config)?.command ?? null;
}

const MOVE_VERB_RE = /(?:^|\s)(?:едь|езжай|поедь|проедь|двигайся|двинься|повернись|поверни|їдь|поїдь|рухайся|повернись|поверни|go|drive|move|turn|va|vas|roule|tourne|bouge|avance|recule|pars)(?=$|[\s.,!?])/iu;

function isBareDirectionCommand(command: string, variants: string): boolean {
  return new RegExp(`^(?:${variants})(?:\\s+(?:пожалуйста|немного|чуть(?:-чуть)?|un\\s+peu|sil\\s+te\\s+pla[iî]t|stp|maintenant))?[.!?]*$`, "i").test(command.trim());
}

/** Standalone built-in STOP is an absolute safety keyword and never requires an address. */
export function containsEmergencyStopWord(text: string, config?: ExplicitRobotCommandConfig): boolean {
  const normalized = normalizeMatchText(text);
  if (/(?:^|\s)(?:стоп|stop)(?=$|\s)/iu.test(normalized)) return true;
  // French: only a short standalone order, so ordinary sentences such as
  // "il n'arrête pas de pleuvoir" never trigger an emergency stop.
  if (/^(?:(?:[a-zà-ÿ]+\s+)?(?:arr[eê]te(?:\s+toi)?|arr[eê]tez|halte|stoppe|ne\s+bouge\s+plus)(?:\s+(?:tout\s+de\s+suite|maintenant))?)$/iu.test(normalized)) return true;
  const listeningLanguage = config?.listeningLanguage ?? "ru";
  return (config?.customVoiceCommands?.emergency_stop ?? []).some((phrase) => phrase.language === listeningLanguage && phraseMatches(normalized, phrase));
}

function phraseMatches(normalizedCommand: string, phrase: CustomVoiceCommandPhrase): boolean {
  return normalizedCommand === normalizeMatchText(phrase.text);
}

type PhysicalCustomVoiceCommandAction = Exclude<CustomVoiceCommandAction, "emergency_stop" | "look_here">;

function customActionFor(command: string, config?: ExplicitRobotCommandConfig): PhysicalCustomVoiceCommandAction | null {
  const listeningLanguage = config?.listeningLanguage ?? "ru";
  const entries = Object.entries(config?.customVoiceCommands ?? {}) as Array<[CustomVoiceCommandAction, CustomVoiceCommandPhrase[]]>;

  // Prefer the phrase language matching the active Listening language. This is
  // the normal path and keeps multilingual aliases predictable.
  for (const [action, phrases] of entries) {
    if (action === "emergency_stop" || action === "look_here") continue;
    if (phrases.some((phrase) => phrase.language === listeningLanguage && phraseMatches(command, phrase))) return action as PhysicalCustomVoiceCommandAction;
  }

  // If the listening language changed after the user created a phrase, an exact
  // addressed custom phrase should still work when it maps unambiguously to one
  // action. Never guess when the same text is configured for different actions.
  const matchingActions = entries
    .filter(([action, phrases]) => action !== "emergency_stop" && action !== "look_here" && phrases.some((phrase) => phraseMatches(command, phrase)))
    .map(([action]) => action as PhysicalCustomVoiceCommandAction);
  return new Set(matchingActions).size === 1 ? matchingActions[0] ?? null : null;
}

function commandFromCustomAction(action: PhysicalCustomVoiceCommandAction, command: string): ExplicitRobotCommand | null {
  switch (action) {
    case "forward": return { kind: "move", direction: "forward" };
    case "backward": return { kind: "move", direction: "backward" };
    case "left": return { kind: "turn", direction: "left", degrees: 90 };
    case "right": return { kind: "turn", direction: "right", degrees: 90 };
    case "turn_around": return { kind: "turn", direction: "right", degrees: 180 };
    case "nod": return { kind: "gesture", gesture: "nod", count: parseRequestedNodCount(command) };
    case "dance": return { kind: "dance" };
    case "sleep": return { kind: "sleep" };
    default: return null;
  }
}

/**
 * Parse deterministic physical commands. Wheel movement/sleep still require an
 * explicit address at utterance start. STOP is additionally handled by the
 * global emergency path before this parser.
 */
function normalizeKnownGluedRobotAddress(text: string): string {
  // Whisper occasionally joins the wake address to a short deterministic command
  // (for example "Луикивни три раза"). Only split known physical-command stems so
  // arbitrary conversational words beginning with "луи" are not broadened.
  return text.trim().replace(
    /^(луи|луй|луни|луї|луі|макс|max|робот|robot|уи|уй|рога)(?=(?:кивни|кивай|стоп|стой|спи|засни|потанцуй|потанцюй|танцуй|танцюй|dance|впер[её]д|назад|влево|вправо|налево|направо|развернись|avance|recule|danse|dors|hoche))/iu,
    "$1 "
  );
}


function stripNaturalCommandLeadIns(command: string): string {
  let value = command.trim();
  // Address-at-start remains mandatory. These fillers are accepted only AFTER
  // a valid "Луи/Робот" address so natural forms like "Робот, давай назад"
  // remain deterministic physical commands rather than broad conversation.
  const leadIn = /^(?:(?:ну\s+)?давай(?:-ка)?|ну-ка|теперь|а\s+теперь|ладно|хорошо|окей|пожалуйста|allez|vas\s+y|bon|ok|okay|daccord|maintenant|sil\s+te\s+pla[iî]t|stp|est\s+ce\s+que\s+tu\s+peux|tu\s+peux|peux\s+tu)\s+/iu;
  for (let i = 0; i < 3; i += 1) {
    const next = value.replace(leadIn, "");
    if (next === value) break;
    value = next.trim();
  }
  return value;
}

export function parseExplicitRobotCommand(text: string, config?: ExplicitRobotCommandConfig): ExplicitRobotCommand | null {
  const addressed = splitAddressedCommand(text, config);
  if (!addressed) return null;

  const command = stripNaturalCommandLeadIns(addressed.command.trim().toLowerCase());
  const customAction = customActionFor(command, config);
  if (customAction) return commandFromCustomAction(customAction, command);

  // French: these verbs are also common nouns/questions ("tu dors ?", "la
  // danse"), so they only count as orders when they start the command.
  const frTail = "(?:\\s+(?:un\\s+peu|sil\\s+te\\s+pla[iî]t|stp|maintenant|pour\\s+moi))?$";
  if (new RegExp(`^(?:dors|va\\s+dormir|endors\\s+toi|fais\\s+dodo|au\\s+lit)${frTail}`, "iu").test(command)) {
    return { kind: "sleep" };
  }
  if (new RegExp(`^(?:hoche(?:\\s+la\\s+t[eê]te)?|acquiesce|fais\\s+oui(?:\\s+de\\s+la\\s+t[eê]te)?)(?:\\s+(?:[1-5]|une|deux|trois|quatre|cinq)\\s+fois)?${frTail}`, "iu").test(command)) {
    return { kind: "gesture", gesture: "nod", count: parseRequestedNodCount(command) };
  }
  if (new RegExp(`^(?:danse|dansez|fais\\s+(?:une|ta)\\s+danse|montre\\s+moi\\s+une\\s+danse)${frTail}`, "iu").test(command)) {
    return { kind: "dance" };
  }

  if (/(?:^|\s)(?:спи|спать|засни|засыпай|иди\s+спать|ложись\s+спать|засинай|спати|іди\s+спати|sleep|go\s+to\s+sleep|fall\s+asleep)(?=$|[\s.,!?])/iu.test(command)) {
    return { kind: "sleep" };
  }

  if (/(?:^|\s)(?:кивни|кивай|сделай\s+кивок|підтверди|зроби\s+кивок|nod|nod\s+your\s+head|confirm)(?=$|[\s.,!?])/iu.test(command)) {
    return { kind: "gesture", gesture: "nod", count: parseRequestedNodCount(command) };
  }

  if (/(?:^|\s)(?:потанцуй|станцуй|танцуй|потанцюй|станцюй|танцюй|dance|do\s+a\s+dance)(?=$|[\s.,!?])/iu.test(command)) {
    return { kind: "dance" };
  }

  if (/(?:^|\s)(?:стоп|стой|остановись|останови\s+движение|стій|зупинись|зупини|stop|halt|arr[eê]te|arr[eê]te\s+toi|arr[eê]tez|halte|stoppe)(?=$|[\s.,!?])/iu.test(command)) {
    return { kind: "move", direction: "stop" };
  }

  if (
    /(?:^|\s)(?:развернись|разверни|повернись\s+обратно|поверни\s+обратно|розвернись|розверни|повернись\s+назад|turn\s+around|make\s+a\s+u\s*turn|u\s*turn|demi\s+tour|retourne\s+toi|volte\s+face)(?=$|[\s.,!?])/iu.test(command) ||
    /(?:^|\s)(?:180|сто\s+восемьдесят|сто\s+вісімдесят|one\s+eighty|cent\s+quatre\s+vingts?)\s*(?:градус(?:ов|а)?|градус(?:ів|и)?|degrees?|degr[eé]s|°)?(?=$|[\s.,!?])/iu.test(command)
  ) {
    // Clockwise/right is the deterministic default for a 180° turn.
    return { kind: "turn", direction: "right", degrees: 180 };
  }

  const hasMoveVerb = MOVE_VERB_RE.test(command);

  if (
    (hasMoveVerb && /(?:^|\s)(?:впер[её]д|вперед|прямо|forward|ahead|straight|en\s+avant|tout\s+droit|devant)(?=$|[\s.,!?])/iu.test(command)) ||
    isBareDirectionCommand(command, "впер[её]д|вперед|прямо|forward|ahead|straight|avance|avancez|en\\s+avant|tout\\s+droit|avance\\s+tout\\s+droit|va\\s+tout\\s+droit|roule")
  ) {
    return { kind: "move", direction: "forward" };
  }
  if (
    (hasMoveVerb && /(?:^|\s)(?:назад|обратно|back|backward|reverse|en\s+arri[eè]re|arri[eè]re)(?=$|[\s.,!?])/iu.test(command)) ||
    isBareDirectionCommand(command, "назад|обратно|back|backward|reverse|recule|reculez|en\\s+arri[eè]re|marche\\s+arri[eè]re")
  ) {
    return { kind: "move", direction: "backward" };
  }
  if (
    (hasMoveVerb && /(?:^|\s)(?:влево|налево|левее|вліво|наліво|ліворуч|left|gauche)(?=$|[\s.,!?])/iu.test(command)) ||
    isBareDirectionCommand(command, "влево|налево|левее|вліво|наліво|ліворуч|left|[aà]\\s+gauche|gauche|tourne\\s+[aà]\\s+gauche")
  ) {
    return { kind: "turn", direction: "left", degrees: 90 };
  }
  if (
    (hasMoveVerb && /(?:^|\s)(?:вправо|направо|правее|праворуч|right|droite)(?=$|[\s.,!?])/iu.test(command)) ||
    isBareDirectionCommand(command, "вправо|направо|правее|праворуч|right|[aà]\\s+droite|droite|tourne\\s+[aà]\\s+droite")
  ) {
    return { kind: "turn", direction: "right", degrees: 90 };
  }

  return null;
}

function parseRequestedNodCount(command: string): number {
  const digit = /(?:^|\s)([1-5])\s*(?:раз(?:а)?|разок|fois)?(?=$|[\s.,!?])/i.exec(command);
  if (digit) return Number(digit[1]);

  const wordCounts: Array<[RegExp, number]> = [
    [/(?:^|\s)cinq\s+fois(?=\s|$)/i, 5],
    [/(?:^|\s)quatre\s+fois(?=\s|$)/i, 4],
    [/(?:^|\s)trois\s+fois(?=\s|$)/i, 3],
    [/(?:^|\s)deux\s+fois(?=\s|$)/i, 2],
    [/(?:^|\s)(?:пять|пятикратно)(?=\s|$|[.,!?])/i, 5],
    [/(?:^|\s)(?:четыре|четырежды)(?=\s|$|[.,!?])/i, 4],
    [/(?:^|\s)(?:три|трижды)(?=\s|$|[.,!?])/i, 3],
    [/(?:^|\s)(?:два|две|дважды)(?=\s|$|[.,!?])/i, 2],
    [/(?:^|\s)(?:один|одна|один раз)(?=\s|$|[.,!?])/i, 1],
  ];
  for (const [pattern, count] of wordCounts) {
    if (pattern.test(command)) return count;
  }
  return 1;
}
