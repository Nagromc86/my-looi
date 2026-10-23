export type ResponseLanguage = "ru" | "uk" | "en" | "fr";

export const DEFAULT_RESPONSE_LANGUAGE: ResponseLanguage = "fr";

export const RESPONSE_LANGUAGE_OPTIONS: ReadonlyArray<{
  id: ResponseLanguage;
  shortLabel: string;
  label: string;
}> = [
  { id: "fr", shortLabel: "FR", label: "Français" },
  { id: "ru", shortLabel: "RU", label: "Русский" },
  { id: "uk", shortLabel: "UA", label: "Українська" },
  { id: "en", shortLabel: "EN", label: "English" },
];

const DIRECT_SWITCH_COMMAND_RE = /^(?:говори|разговаривай|отвечай|ответь|розмовляй|спілкуйся|відповідай|speak|talk|reply|respond|parle|r[eé]ponds)(?=$|\s)/u;

const POLITE_SWITCH_COMMAND_RE = /^(?:(?:можешь|можеш|чи\s+можеш|can\s+you|could\s+you|tu\s+peux|peux\s+tu|est\s+ce\s+que\s+tu\s+peux)(?:\s+(?:пожалуйста|будь\s+ласка|please|теперь|відтепер|now|maintenant|s.?il\s+te\s+pla[iî]t|stp))*\s+)(?:говорить|разговаривать|отвечать|говорити|спілкуватися|відповідати|speak|talk|reply|respond|parler|r[eé]pondre|me\s+parler|me\s+r[eé]pondre)(?=$|\s)/u;

const RESPONSE_SETTING_COMMAND_RE = /^(?:переключи|смени|поменяй|выбери|зміни|перемкни|обери|switch|change|set)\s+(?:язык\s+ответов|мову\s+відповідей|response\s+language)(?=$|\s)/u;

const FR_RESPONSE_SETTING_COMMAND_RE = /^(?:change|passe|mets)\s+(?:la\s+)?langue(?:\s+de\s+r[eé]ponse)?(?=$|\s)/u;

const COMMAND_LEADING_MODIFIER_RE = /^(?:пожалуйста|будь\s+ласка|please|теперь|отныне|відтепер|надалі|now|from\s+now\s+on|maintenant|d[eé]sormais|s.?il\s+te\s+pla[iî]t|stp)(?=$|\s)/u;

const TARGET_MODIFIER_RE = /^(?:пожалуйста|будь\s+ласка|please|теперь|отныне|відтепер|надалі|now|from\s+now\s+on|со\s+мной|зі\s+мною|with\s+me|maintenant|d[eé]sormais|s.?il\s+te\s+pla[iî]t|stp|avec\s+moi|moi)(?=$|\s)/u;

const LANGUAGE_TARGETS: Array<{
  language: ResponseLanguage;
  pattern: RegExp;
}> = [
  {
    language: "ru",
    pattern: /^(?:(?:(?:язык(?:\s+ответов)?|мову(?:\s+відповідей)?|(?:response\s+)?language)\s+(?:на|to)\s+)?(?:русский(?:\s+язык)?|російську(?:\s+мову)?|russian)|по[-\s]?русски|на\s+русском(?:\s+языке)?|на\s+русский(?:\s+язык)?|російською|на\s+російську(?:\s+мову)?|російська(?:\s+мова)?|in\s+russian|to\s+russian|(?:en\s+|le\s+|l.?)?russe|(?:au\s+|à\s+|a\s+)?russe|(?:(?:la\s+)?langue\s+)?(?:en\s+)russe)(?:\s+(?:пожалуйста|будь\s+ласка|please|s.?il\s+te\s+pla[iî]t|stp))?$/u,
  },
  {
    language: "uk",
    pattern: /^(?:(?:(?:язык(?:\s+ответов)?|мову(?:\s+відповідей)?|(?:response\s+)?language)\s+(?:на|to)\s+)?(?:украинский(?:\s+язык)?|українську(?:\s+мову)?|ukrainian)|по[-\s]?украински|на\s+украинском(?:\s+языке)?|на\s+украинский(?:\s+язык)?|українською|на\s+українську(?:\s+мову)?|українська(?:\s+мова)?|in\s+ukrainian|to\s+ukrainian|(?:en\s+|le\s+|l.?)?ukrainien|(?:au\s+|à\s+|a\s+)?ukrainien|(?:(?:la\s+)?langue\s+)?(?:en\s+)ukrainien)(?:\s+(?:пожалуйста|будь\s+ласка|please|s.?il\s+te\s+pla[iî]t|stp))?$/u,
  },
  {
    language: "en",
    pattern: /^(?:(?:(?:язык(?:\s+ответов)?|мову(?:\s+відповідей)?|(?:response\s+)?language)\s+(?:на|to)\s+)?(?:английский(?:\s+язык)?|англійську(?:\s+мову)?|english)|по[-\s]?английски|на\s+английском(?:\s+языке)?|на\s+английский(?:\s+язык)?|англійською|на\s+англійську(?:\s+мову)?|англійська(?:\s+мова)?|in\s+english|to\s+english|(?:en\s+|le\s+|l.?)?anglais|(?:au\s+|à\s+|a\s+)?anglais|(?:(?:la\s+)?langue\s+)?(?:en\s+)anglais)(?:\s+(?:пожалуйста|будь\s+ласка|please|s.?il\s+te\s+pla[iî]t|stp))?$/u,
  },
  {
    language: "fr",
    pattern: /^(?:(?:(?:язык(?:\s+ответов)?|мову(?:\s+відповідей)?|(?:response\s+)?language)\s+(?:на|to)\s+)?(?:французский(?:\s+язык)?|французьку(?:\s+мову)?|french)|по[-\s]?французски|на\s+французском(?:\s+языке)?|французькою|in\s+french|to\s+french|(?:en\s+|le\s+)?fran[cç]ais|(?:(?:la\s+)?langue\s+)?en\s+fran[cç]ais)(?:\s+(?:пожалуйста|будь\s+ласка|please|s.?il\s+te\s+pla[iî]t|stp))?$/u,
  },
];

export function normalizeResponseLanguage(value: unknown): ResponseLanguage {
  return value === "uk" || value === "en" || value === "ru" || value === "fr"
    ? value
    : DEFAULT_RESPONSE_LANGUAGE;
}

/**
 * Recognize only an explicit request to change LOOI's persistent answer
 * language. Ordinary translation questions intentionally do not match.
 */
export function detectLanguageSwitchCommand(transcript: string): ResponseLanguage | null {
  const normalized = transcript
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  let commandText = normalized;
  while (COMMAND_LEADING_MODIFIER_RE.test(commandText)) {
    commandText = commandText.replace(COMMAND_LEADING_MODIFIER_RE, "").trim();
  }

  const command = RESPONSE_SETTING_COMMAND_RE.exec(commandText)
    ?? FR_RESPONSE_SETTING_COMMAND_RE.exec(commandText)
    ?? POLITE_SWITCH_COMMAND_RE.exec(commandText)
    ?? DIRECT_SWITCH_COMMAND_RE.exec(commandText);
  if (!command) {
    return null;
  }

  let target = commandText.slice(command[0].length).trim();
  while (TARGET_MODIFIER_RE.test(target)) {
    target = target.replace(TARGET_MODIFIER_RE, "").trim();
  }
  return LANGUAGE_TARGETS.find(({ pattern }) => pattern.test(target))?.language ?? null;
}

export function getLanguageSwitchAcknowledgement(language: ResponseLanguage): string {
  if (language === "fr") return "D'accord, je parle français.";
  if (language === "uk") return "Добре, говоритиму українською.";
  if (language === "en") return "Okay, I'll speak English.";
  return "Хорошо, буду говорить по-русски.";
}

export function getResponseLanguageName(language: ResponseLanguage): string {
  if (language === "uk") return "Ukrainian";
  if (language === "en") return "English";
  if (language === "fr") return "French";
  return "Russian";
}
