// 语言检测：franc-min + iso-639-3，与 opencode-mem language-detector 对齐
import { franc } from "franc-min";
import { iso6393, iso6393To1 } from "iso-639-3";

// 无 639-1 等价的三字码回退表
const FALLBACK_MAP: Record<string, string> = {
  cmn: "zh",
  yue: "zh",
  arz: "ar",
  hbs: "sr",
};

export function detectLanguage(text: string): string {
  if (!text || text.trim().length === 0) return "en";
  const detected = franc(text, { minLength: 5 });
  if (detected === "und") return "en";
  const twoLetter = iso6393To1[detected];
  if (twoLetter) return twoLetter;
  return FALLBACK_MAP[detected] ?? "en";
}

export function getLanguageName(code: string): string {
  let lang = iso6393.find((l) => l.iso6391 === code);
  if (!lang) lang = iso6393.find((l) => l.iso6393 === code);
  return lang?.name ?? "English";
}

/** 按配置解析目标语言名：auto 时检测，否则用配置值 */
export function resolveLanguageName(configured: string, sampleText: string): string {
  const lang = configured === "auto" || !configured ? detectLanguage(sampleText) : configured;
  return getLanguageName(lang);
}
