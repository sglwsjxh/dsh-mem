// 注入内容过滤：区分宿主/插件注入的文本与用户真实输入
// 改写自 opencode-mem injected-prompt-filter，适配 dsh 的 UserMessage.content 结构

/** 独立注入块的行首标记：宿主/插件单独注入时整块以此开头 */
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

/**
 * 成对注入标签：dsh 会把 workspace instructions 等以 <system-reminder> 形式
 * 拼进用户消息正文。这类段落必须剥离而非整块丢弃——否则混合块里的用户真实输入
 * 会被误杀，导致自动捕获对真实会话永不生效。
 */
const INJECTION_SPAN_PATTERNS: readonly RegExp[] = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<team_mode_status(?:\s[^>]*)?>[\s\S]*?<\/team_mode_status>/gi,
  /<auto-slash-command>[\s\S]*?<\/auto-slash-command>/gi,
];

/** 剥离成对注入标签，返回剩余文本 */
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

/**
 * 单个文本块是否为纯注入内容。
 * synthetic 标记优先；成对标签剥离后为空视为纯注入；
 * 剩余文本以独立注入标记开头才判为注入（避免误杀混合块）。
 */
export function isInjectedBlock(block: FilterableTextBlock, markers: readonly string[] = DEFAULT_INJECTION_MARKERS): boolean {
  if (block.synthetic === true) return true;
  const stripped = stripInjectionSpans(block.text);
  if (!stripped) return true;
  const head = stripped.trimStart().toLowerCase();
  return markers.some((marker) => marker !== "" && head.startsWith(marker.toLowerCase()));
}

/** 过滤注入块并剥离注入段落，返回用户真实编写的文本 */
export function filterInjectedBlocks(blocks: readonly FilterableTextBlock[], markers: readonly string[] = DEFAULT_INJECTION_MARKERS): FilterableTextBlock[] {
  const out: FilterableTextBlock[] = [];
  for (const block of blocks) {
    if (isInjectedBlock(block, markers)) continue;
    out.push({ ...block, text: stripInjectionSpans(block.text) });
  }
  return out;
}

/** 内部结构化总结标记：防止自动捕获自引用循环 */
export function isInternalSummaryPrompt(text: string): boolean {
  if (!text) return false;
  if (text.includes("# User Profile Analysis")) return true;
  return text.includes("Analyze this conversation.") && text.includes('type="skip"');
}
