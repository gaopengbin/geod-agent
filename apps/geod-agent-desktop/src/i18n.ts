import { useSyncExternalStore } from "react";
import english from "./locales/en.json";

export type Locale = "zh-CN" | "en";
export type LanguagePreference = Locale | "auto";
export type ReplyLanguage = LanguagePreference | "interface";
export interface LanguagePreferences { language: LanguagePreference; replyLanguage: ReplyLanguage }
const preferenceKey = "geod-agent-language-v1";
const defaults: LanguagePreferences = { language: "auto", replyLanguage: "auto" };
const supported = (value: unknown): value is LanguagePreference => value === "auto" || value === "zh-CN" || value === "en";
function read(): LanguagePreferences {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(preferenceKey) ?? "null");
    return { language: supported(value?.language) ? value.language : defaults.language,
      replyLanguage: supported(value?.replyLanguage) || value?.replyLanguage === "interface" ? value.replyLanguage : defaults.replyLanguage };
  } catch { return defaults; }
}
type LanguageState = { preferences: LanguagePreferences; listeners: Set<() => void> };
const shared = globalThis as typeof globalThis & { __GEOD_LANGUAGE__?: LanguageState };
const state = shared.__GEOD_LANGUAGE__ ??= { preferences: read(), listeners: new Set() };
export function getLocale(): Locale {
  if (state.preferences.language !== "auto") return state.preferences.language;
  return globalThis.navigator?.language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}
export const getLanguagePreferences = () => state.preferences;
const subscribe = (listener: () => void) => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; };
export function useLocale() { return useSyncExternalStore(subscribe, getLocale, () => "zh-CN" as Locale); }
export function useLanguagePreferences() { return useSyncExternalStore(subscribe, getLanguagePreferences, () => defaults); }
export function setLanguagePreferences(change: Partial<LanguagePreferences>) {
  const next = { ...state.preferences, ...change };
  if (!supported(next.language) || !(supported(next.replyLanguage) || next.replyLanguage === "interface")) throw new Error("Unsupported language");
  globalThis.localStorage?.setItem(preferenceKey, JSON.stringify(next));
  state.preferences = next;
  if (typeof document !== "undefined") document.documentElement.lang = getLocale();
  for (const listener of state.listeners) listener();
}
if (typeof document !== "undefined") document.documentElement.lang = getLocale();
if (typeof window !== "undefined") window.addEventListener("languagechange", () => {
  document.documentElement.lang = getLocale(); for (const listener of state.listeners) listener();
});

const catalogue = english as Record<string, string>;
const normalize = (value: string) => value.trim().replace(/\s+/gu, " ");
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = Object.entries(catalogue).filter(([key]) => /\{\d+\}/u.test(key)).map(([key, translated]) => {
  const parameters: string[] = [], pieces: string[] = [];
  let offset = 0;
  for (const match of key.matchAll(/\{(\d+)\}/gu)) {
    pieces.push(escape(key.slice(offset, match.index)), "([\\s\\S]*?)");
    parameters.push(match[1]); offset = match.index! + match[0].length;
  }
  pieces.push(escape(key.slice(offset)));
  return { expression: new RegExp(`^${pieces.join("")}$`, "u"), translated, parameters, specificity: key.replace(/\{\d+\}/gu, "").length };
}).sort((a, b) => b.specificity - a.specificity);
const interpolate = (value: string, parameters: Record<string, unknown>) => value.replace(/\{(\d+)\}/gu, (token, key) => key in parameters ? String(parameters[key] ?? "") : token);
/** Source-language message IDs; translations never change user text or tool contracts. */
export function t(message: string, parameters?: Record<string, unknown>): string {
  const source = parameters ? interpolate(message, parameters) : message;
  if (getLocale() === "zh-CN") return source;
  const key = normalize(message), translated = catalogue[key];
  if (translated) {
    const prefix = message.match(/^\s+/u)?.[0] ?? "", suffix = message.match(/\s+$/u)?.[0] ?? "";
    return prefix + (parameters ? interpolate(translated.trim(), parameters) : translated.trim()) + suffix;
  }
  if (parameters || !/[\u3400-\u9fff]/u.test(source)) return source;
  for (const pattern of patterns) {
    const match = pattern.expression.exec(normalize(source));
    if (match) return interpolate(pattern.translated, Object.fromEntries(pattern.parameters.map((key, index) => [key, match[index + 1]])));
  }
  return source;
}
/** React expression boundary: only strings are localized; elements and data stay intact. */
export function localize<T>(value: T): T { return (typeof value === "string" ? t(value) : value) as T; }
export function replyLanguageInstruction(input: string): string {
  const preference = state.preferences.replyLanguage;
  const locale = preference === "interface" ? getLocale() : preference === "auto" ? /[\u3400-\u9fff]/u.test(input) ? "zh-CN" : "en" : preference;
  return locale === "zh-CN" ? "请全程使用中文，包括执行前的说明和最终答复。我的请求：\n" : "Use English for your commentary and final answer. My request:\n";
}
