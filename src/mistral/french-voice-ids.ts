// French fork: voice ids kept dependency-free so the preferences store can
// import them without loading the speech engine.
export type FrenchVoiceId = "tom" | "siwis";

export function normalizeFrenchVoiceId(value: unknown): FrenchVoiceId {
  return value === "siwis" ? "siwis" : "tom";
}
