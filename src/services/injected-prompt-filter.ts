/**
 * dsh-mem
 *
 * Copyright (C) 2026 dsh-mem contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

// 注入内容过滤：区分宿主注入文本与用户真实输入

/** 独立注入块的行首标记 */
export const DEFAULT_INJECTION_MARKERS: readonly string[] = [
  "<system-reminder>",
  "<!-- OMO_INTERNAL_INITIATOR -->",
  "<!-- OMO_INTERNAL_NOREPLY -->",
  "[SYSTEM DIRECTIVE: OH-MY-OPENCODE",
  "[Agent Usage Reminder]",
  "[Category+Skill Reminder]",
  "<team_mode_status",
  "<auto-slash-command>",
];

/** 成对注入标签。dsh 会把 workspace instructions 拼进用户消息正文，这类段落必须剥离而非整块丢弃，否则混合块里的真实输入会被误杀 */
const INJECTION_SPAN_PATTERNS: readonly RegExp[] = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<team_mode_status(?:\s[^>]*)?>[\s\S]*?<\/team_mode_status>/gi,
  /<auto-slash-command>[\s\S]*?<\/auto-slash-command>/gi,
];

export function stripInjectionSpans(text: string): string {
  let out = text;
  for (const pattern of INJECTION_SPAN_PATTERNS) {
    out = out.replace(pattern, "");
  }
  return out.trim();
}

export function containsInjectionMarker(text: string, markers: readonly string[] = DEFAULT_INJECTION_MARKERS): boolean {
  if (!text) return false;
  const haystack = text.toLowerCase();
  for (const marker of markers) {
    if (!marker) continue;
    if (haystack.includes(marker.toLowerCase())) return true;
  }
  return false;
}

/** 文本块最小形状 */
export interface FilterableTextBlock {
  type: string;
  text: string;
  synthetic?: boolean;
}

export function extractTextBlocks(blocks: readonly unknown[]): FilterableTextBlock[] {
  const out: FilterableTextBlock[] = [];
  for (const block of blocks) {
    if (block && typeof block === "object") {
      const b = block as { type?: string; text?: unknown; synthetic?: unknown };
      if (b.type === "text" && typeof b.text === "string") {
        out.push({ type: "text", text: b.text, synthetic: b.synthetic === true });
      }
    }
  }
  return out;
}

/** 单个文本块是否纯注入。synthetic 优先，剥离成对标签后为空视为纯注入，剩余文本以独立标记开头才判为注入，避免误杀混合块 */
export function isInjectedBlock(block: FilterableTextBlock, markers: readonly string[] = DEFAULT_INJECTION_MARKERS): boolean {
  if (block.synthetic === true) return true;
  const stripped = stripInjectionSpans(block.text);
  if (!stripped) return true;
  const head = stripped.trimStart().toLowerCase();
  return markers.some((marker) => marker !== "" && head.startsWith(marker.toLowerCase()));
}

/** 过滤注入块并剥离注入段落，返回用户真实文本 */
export function filterInjectedBlocks(blocks: readonly FilterableTextBlock[], markers: readonly string[] = DEFAULT_INJECTION_MARKERS): FilterableTextBlock[] {
  const out: FilterableTextBlock[] = [];
  for (const block of blocks) {
    if (isInjectedBlock(block, markers)) continue;
    out.push({ ...block, text: stripInjectionSpans(block.text) });
  }
  return out;
}

/** 内部总结标记，防止自动捕获自引用 */
export function isInternalSummaryPrompt(text: string): boolean {
  if (!text) return false;
  if (text.includes("# User Profile Analysis")) return true;
  return text.includes("Analyze this conversation.") && text.includes('type="skip"');
}
