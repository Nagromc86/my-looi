// French fork addition: Gemini Live prebuilt voices (all speak French).
export type GeminiVoiceOption = { id: string; descriptionFr: string; descriptionEn: string };

export const GEMINI_VOICES: readonly GeminiVoiceOption[] = [
  { id: "Puck", descriptionFr: "Enjoué", descriptionEn: "Upbeat" },
  { id: "Charon", descriptionFr: "Posé, informatif", descriptionEn: "Informative" },
  { id: "Fenrir", descriptionFr: "Énergique", descriptionEn: "Excitable" },
  { id: "Orus", descriptionFr: "Assuré", descriptionEn: "Firm" },
  { id: "Kore", descriptionFr: "Ferme", descriptionEn: "Firm" },
  { id: "Aoede", descriptionFr: "Légère", descriptionEn: "Breezy" },
  { id: "Leda", descriptionFr: "Jeune", descriptionEn: "Youthful" },
  { id: "Zephyr", descriptionFr: "Lumineuse", descriptionEn: "Bright" },
];

export const DEFAULT_GEMINI_VOICE_ID = "Puck";

export function normalizeGeminiVoiceId(value: unknown): string {
  return typeof value === "string" && GEMINI_VOICES.some((voice) => voice.id === value) ? value : DEFAULT_GEMINI_VOICE_ID;
}
