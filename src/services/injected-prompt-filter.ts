// 注入内容过滤：区分宿主/插件注入的文本与用户真实输入
// 改写自 opencode-mem injected-prompt-filter，适配 dsh 的 UserMessage.content 结构

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

export function containsInjectionMarker(text: string, markers: readonly string[] = DEFAULT_INJECTION_MARKERS): boolean {
  if (!text) return false;
  const haystack = text.toLowerCase();
  for (const marker of markers) {
    if (!marker) continue;
    if (haystack.includes(marker.toLowerCase())) return true;
  }
  return false;
}

/** dsh 文本块最小形状：与 ContentBlock 的 text 块兼容 */
export interface FilterableTextBlock {
  type: string;
  text: string;
  synthetic?: boolean;
}

/** 从 content blocks 中抽取文本块 */
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

/** 单个文本块是否为注入内容 */
export function isInjectedBlock(block: FilterableTextBlock, markers: readonly string[] = DEFAULT_INJECTION_MARKERS): boolean {
  if (block.synthetic === true) return true;
  return containsInjectionMarker(block.text, markers);
}

/** 过滤注入块，返回用户真实编写的文本块 */
export function filterInjectedBlocks(blocks: readonly FilterableTextBlock[], markers: readonly string[] = DEFAULT_INJECTION_MARKERS): FilterableTextBlock[] {
  return blocks.filter((block) => !isInjectedBlock(block, markers));
}

/** 内部结构化总结标记：防止自动捕获自引用循环 */
export function isInternalSummaryPrompt(text: string): boolean {
  if (!text) return false;
  if (text.includes("# User Profile Analysis")) return true;
  return text.includes("Analyze this conversation.") && text.includes('type="skip"');
}
