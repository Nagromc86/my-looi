import type { ListeningLanguage } from "../language/listening-language";

export type DrivingCommand =
  | { kind: "stop" }
  | { kind: "move"; direction: "forward" | "backward" }
  | { kind: "turn"; direction: "left" | "right"; degrees: 90 | 180 }
  | { kind: "gesture"; gesture: "nod" | "happy_bob"; count: number }
  | { kind: "dance" }
  | { kind: "sleep" }
  | { kind: "light"; enabled: boolean }
  | { kind: "exit" };

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:()\[\]{}"“”'`~]+/gu, " ")
    .replace(/[\-–—]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function stripFillers(text: string, language: ListeningLanguage): string {
  const fillers: Record<ListeningLanguage, RegExp> = {
    ru: /^(?:(?:ну|давай|да|ага|эй|ой|пожалуйста|быстро|сейчас|уже|робот|луи|луй|макс|max|уи|уй)\s+)*/u,
    uk: /^(?:(?:ну|давай|так|ага|ей|ой|будь\s+ласка|швидко|зараз|вже|робот|луї|луі|макс|max)\s+)*/u,
    en: /^(?:(?:well|okay|ok|hey|please|quickly|now|already|robot|looi|louie|max)\s+)*/u,
    fr: /^(?:(?:allez|vas\s+y|va\s+y|bon|ok|okay|d\s+accord|daccord|h[eé]|hey|eh|s\s+il\s+te\s+pla[iî]t|stp|maintenant|vite|robot|looi|louis|louie|loui|loulou|max)\s+)*/u,
  };
  return text.replace(fillers[language], "").trim();
}

/**
 * Deterministic on-device parser used while the wheels are moving.
 *
 * Safety rule: arbitrary speech never escapes this parser to remote STT/LLM.
 * Only this bounded physical-command vocabulary is executable without the
 * normal "Луи/Робот" address while driving. STOP aliases intentionally work
 * across all three languages regardless of the selected listening language.
 */
export function parseDrivingCommandTranscript(
  transcript: string,
  language: ListeningLanguage
): DrivingCommand | null {
  const normalized = normalize(transcript);
  if (!normalized) return null;

  // Explicitly leave local physical-control mode. A plain "хватит" remains
  // an emergency STOP; exiting the session requires an unambiguous phrase.
  if (/^(?:вс[её]|закончили|хватит\s+управлять|обычный\s+режим|поговорим|давай\s+поговорим|все\s+команды\s+закончили)$/u.test(normalized)) {
    return { kind: "exit" };
  }
  if (/^(?:все|закінчили|досить\s+керувати|звичайний\s+режим|поговорімо|давай\s+поговоримо)$/u.test(normalized)) {
    return { kind: "exit" };
  }
  if (/^(?:done|finish\s+driving|stop\s+driving|normal\s+mode|conversation\s+mode|let'?s\s+talk)$/u.test(normalized)) {
    return { kind: "exit" };
  }
  if (/^(?:c\s+est\s+fini|c\s+est\s+bon|termin[eé]|fini|mode\s+normal|mode\s+conversation|on\s+discute|parlons|on\s+parle|fin\s+de\s+la\s+conduite)$/u.test(normalized)) {
    return { kind: "exit" };
  }

  // STOP is deliberately broad and multilingual. During a local control
  // session, an accidental stop is much safer than an ignored emergency command.
  const padded = ` ${normalized} `;
  if (
    /(?:^|\s)(?:стоп|стой|стій|stop|halt|замри|завмри|тормози|гальмуй|остановись|останови|зупинись|зупини|хватит|досить|достаточно|не\s+надо|не\s+треба|freeze|brake|enough|hold|arr[eê]te|arr[eê]tez|arr[eê]ter|stoppe|halte|suffit|bouge\s+plus|freine|pause)(?:$|\s)/u.test(
      padded
    )
  ) {
    return { kind: "stop" };
  }

  // Local tiny Whisper sometimes maps a short Russian/Ukrainian STOP to a
  // phonetically nearby one-word transcript. These aliases are intentionally
  // accepted ONLY in driving mode. They must never be used by normal chat or
  // addressed-command parsing. The list is based on physical-device logs.
  const fuzzyStopToken = /^(?:ст[аоэеё]?[пй]|стое|стои|сто|степ|степо|степлые|стап|стопп|слой|слышь|ско|step|stap|stahp|stopp)$/u;
  const fuzzyWords = normalized.split(" ").filter(Boolean);
  if (
    (fuzzyWords.length >= 1 && fuzzyWords.length <= 3 && fuzzyWords.every((word) => fuzzyStopToken.test(word))) ||
    /^(?:стой|стоп)(?:\s+(?:стой|стоп)){1,2}$/u.test(normalized)
  ) {
    return { kind: "stop" };
  }

  const compact = stripFillers(normalized, language);
  const words = compact.split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 7) return null;

  if (language === "ru") {
    if (/^(?:развернись|разверни|разворот|повернись\s+назад|кругом|на\s+сто\s+восемьдесят)$/u.test(compact)) {
      return { kind: "turn", direction: "right", degrees: 180 };
    }
    if (/^(?:впер[её]д|прямо|поехали|ед[ьъ]?\s+впер[её]д|двигайся\s+впер[её]д)$/u.test(compact)) {
      return { kind: "move", direction: "forward" };
    }
    if (/^(?:назад|обратно|ед[ьъ]?\s+назад|двигайся\s+назад)$/u.test(compact)) {
      return { kind: "move", direction: "backward" };
    }
    if (/^(?:влево|налево|лево|поверни\s+(?:влево|налево)|поворачивай\s+(?:влево|налево))$/u.test(compact)) {
      return { kind: "turn", direction: "left", degrees: 90 };
    }
    if (/^(?:вправо|направо|право|поверни\s+(?:вправо|направо)|поворачивай\s+(?:вправо|направо))$/u.test(compact)) {
      return { kind: "turn", direction: "right", degrees: 90 };
    }
    if (/^(?:кивни|подтверди|подтверждай|скажи\s+да\s+головой)$/u.test(compact)) {
      return { kind: "gesture", gesture: "nod", count: 1 };
    }
    if (/^(?:кивни\s+(?:два|2)\s+раза|дважды\s+кивни)$/u.test(compact)) {
      return { kind: "gesture", gesture: "nod", count: 2 };
    }
    if (/^(?:кивни\s+(?:три|3)\s+раза|трижды\s+кивни)$/u.test(compact)) {
      return { kind: "gesture", gesture: "nod", count: 3 };
    }
    if (/^(?:покачай\s+головой|помаши\s+головой|головой\s+помаши)$/u.test(compact)) {
      return { kind: "gesture", gesture: "happy_bob", count: 1 };
    }
    if (/^(?:потанцуй|танцуй|станцуй|танец|покрутись|покружись)$/u.test(compact)) {
      return { kind: "dance" };
    }
    if (/^(?:спи|засни|усни|иди\s+спать)$/u.test(compact)) {
      return { kind: "sleep" };
    }
    if (/^(?:включи\s+свет|свет\s+включи|зажги\s+свет)$/u.test(compact)) {
      return { kind: "light", enabled: true };
    }
    if (/^(?:выключи\s+свет|свет\s+выключи|погаси\s+свет)$/u.test(compact)) {
      return { kind: "light", enabled: false };
    }
  } else if (language === "uk") {
    if (/^(?:розвернись|розверни|розворот|кругом|на\s+сто\s+вісімдесят)$/u.test(compact)) {
      return { kind: "turn", direction: "right", degrees: 180 };
    }
    if (/^(?:вперед|прямо|поїхали|їдь\s+вперед|рухайся\s+вперед)$/u.test(compact)) {
      return { kind: "move", direction: "forward" };
    }
    if (/^(?:назад|їдь\s+назад|рухайся\s+назад)$/u.test(compact)) {
      return { kind: "move", direction: "backward" };
    }
    if (/^(?:вліво|наліво|ліворуч|поверни\s+(?:вліво|наліво|ліворуч)|повертай\s+(?:вліво|наліво|ліворуч))$/u.test(compact)) {
      return { kind: "turn", direction: "left", degrees: 90 };
    }
    if (/^(?:вправо|направо|праворуч|поверни\s+(?:вправо|направо|праворуч)|повертай\s+(?:вправо|направо|праворуч))$/u.test(compact)) {
      return { kind: "turn", direction: "right", degrees: 90 };
    }
    if (/^(?:кивни|підтверди|скажи\s+так\s+головою)$/u.test(compact)) {
      return { kind: "gesture", gesture: "nod", count: 1 };
    }
    if (/^(?:кивни\s+(?:два|2)\s+рази|двічі\s+кивни)$/u.test(compact)) {
      return { kind: "gesture", gesture: "nod", count: 2 };
    }
    if (/^(?:кивни\s+(?:три|3)\s+рази|тричі\s+кивни)$/u.test(compact)) {
      return { kind: "gesture", gesture: "nod", count: 3 };
    }
    if (/^(?:похитай\s+головою|помахай\s+головою)$/u.test(compact)) {
      return { kind: "gesture", gesture: "happy_bob", count: 1 };
    }
    if (/^(?:потанцюй|танцюй|станцюй|танець|покрутись)$/u.test(compact)) {
      return { kind: "dance" };
    }
    if (/^(?:спи|засни|засинай|іди\s+спати)$/u.test(compact)) {
      return { kind: "sleep" };
    }
    if (/^(?:увімкни\s+світло|включи\s+світло|світло\s+увімкни)$/u.test(compact)) {
      return { kind: "light", enabled: true };
    }
    if (/^(?:вимкни\s+світло|світло\s+вимкни)$/u.test(compact)) {
      return { kind: "light", enabled: false };
    }
  } else if (language === "fr") {
    if (/^(?:demi\s+tour|fais\s+(?:un\s+)?demi\s+tour|retourne\s+toi|volte\s+face|fais\s+volte\s+face|cent\s+quatre\s+vingts?|tourne\s+toi)$/u.test(compact)) {
      return { kind: "turn", direction: "right", degrees: 180 };
    }
    if (/^(?:avance|avancez|en\s+avant|tout\s+droit|va\s+tout\s+droit|va\s+en\s+avant|avance\s+tout\s+droit|roule|avance\s+un\s+peu)$/u.test(compact)) {
      return { kind: "move", direction: "forward" };
    }
    if (/^(?:recule|reculez|en\s+arri[eè]re|arri[eè]re|marche\s+arri[eè]re|va\s+en\s+arri[eè]re|recule\s+un\s+peu)$/u.test(compact)) {
      return { kind: "move", direction: "backward" };
    }
    if (/^(?:(?:[aà]\s+)?gauche|tourne\s+[aà]\s+gauche|va\s+[aà]\s+gauche|virage\s+[aà]\s+gauche|vers\s+la\s+gauche)$/u.test(compact)) {
      return { kind: "turn", direction: "left", degrees: 90 };
    }
    if (/^(?:(?:[aà]\s+)?droite|tourne\s+[aà]\s+droite|va\s+[aà]\s+droite|virage\s+[aà]\s+droite|vers\s+la\s+droite)$/u.test(compact)) {
      return { kind: "turn", direction: "right", degrees: 90 };
    }
    if (/^(?:hoche\s+la\s+t[eê]te|hoche|acquiesce|fais\s+oui(?:\s+de\s+la\s+t[eê]te)?|dis\s+oui\s+de\s+la\s+t[eê]te)$/u.test(compact)) {
      return { kind: "gesture", gesture: "nod", count: 1 };
    }
    if (/^(?:hoche\s+la\s+t[eê]te\s+(?:deux|2)\s+fois|deux\s+hochements)$/u.test(compact)) {
      return { kind: "gesture", gesture: "nod", count: 2 };
    }
    if (/^(?:hoche\s+la\s+t[eê]te\s+(?:trois|3)\s+fois|trois\s+hochements)$/u.test(compact)) {
      return { kind: "gesture", gesture: "nod", count: 3 };
    }
    if (/^(?:bouge\s+la\s+t[eê]te|remue\s+la\s+t[eê]te|balance\s+la\s+t[eê]te)$/u.test(compact)) {
      return { kind: "gesture", gesture: "happy_bob", count: 1 };
    }
    if (/^(?:danse|dansez|danse\s+pour\s+moi|fais\s+une\s+danse|montre\s+moi\s+une\s+danse|fais\s+ta\s+danse)$/u.test(compact)) {
      return { kind: "dance" };
    }
    if (/^(?:dors|va\s+dormir|endors\s+toi|au\s+lit|fais\s+dodo|dodo)$/u.test(compact)) {
      return { kind: "sleep" };
    }
    if (/^(?:allume\s+la\s+lumi[eè]re|allume\s+la\s+lampe|lumi[eè]re)$/u.test(compact)) {
      return { kind: "light", enabled: true };
    }
    if (/^(?:[eé]teins\s+la\s+lumi[eè]re|[eé]teins\s+la\s+lampe)$/u.test(compact)) {
      return { kind: "light", enabled: false };
    }
  } else {
    if (/^(?:turn\s+around|u\s*turn|make\s+a\s+u\s*turn|one\s+eighty|turn\s+one\s+eighty)$/u.test(compact)) {
      return { kind: "turn", direction: "right", degrees: 180 };
    }
    if (/^(?:forward|ahead|go\s+forward|go\s+ahead|drive\s+forward|straight)$/u.test(compact)) {
      return { kind: "move", direction: "forward" };
    }
    if (/^(?:back|backward|go\s+back|go\s+backward|drive\s+back)$/u.test(compact)) {
      return { kind: "move", direction: "backward" };
    }
    if (/^(?:left|turn\s+left|go\s+left)$/u.test(compact)) {
      return { kind: "turn", direction: "left", degrees: 90 };
    }
    if (/^(?:right|turn\s+right|go\s+right)$/u.test(compact)) {
      return { kind: "turn", direction: "right", degrees: 90 };
    }
    if (/^(?:nod|confirm|say\s+yes\s+with\s+your\s+head)$/u.test(compact)) {
      return { kind: "gesture", gesture: "nod", count: 1 };
    }
    if (/^(?:nod\s+twice|nod\s+(?:two|2)\s+times)$/u.test(compact)) {
      return { kind: "gesture", gesture: "nod", count: 2 };
    }
    if (/^(?:nod\s+(?:three|3)\s+times)$/u.test(compact)) {
      return { kind: "gesture", gesture: "nod", count: 3 };
    }
    if (/^(?:bob\s+your\s+head|wave\s+your\s+head|head\s+bob)$/u.test(compact)) {
      return { kind: "gesture", gesture: "happy_bob", count: 1 };
    }
    if (/^(?:dance|do\s+a\s+dance|dance\s+for\s+me|spin\s+and\s+dance)$/u.test(compact)) {
      return { kind: "dance" };
    }
    if (/^(?:sleep|go\s+to\s+sleep|fall\s+asleep)$/u.test(compact)) {
      return { kind: "sleep" };
    }
    if (/^(?:lights\s+on|light\s+on|turn\s+on\s+the\s+light)$/u.test(compact)) {
      return { kind: "light", enabled: true };
    }
    if (/^(?:lights\s+off|light\s+off|turn\s+off\s+the\s+light)$/u.test(compact)) {
      return { kind: "light", enabled: false };
    }
  }

  return null;
}
