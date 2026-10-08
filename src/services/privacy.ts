// 隐私过滤：<private>…</private> 区域替换为 [REDACTED]
// 逻辑与 opencode-mem privacy.ts 对齐：未闭合闭合到末尾，嵌套闭合到外层
const REDACTED = "[REDACTED]";
const PRIVATE_TAG = /<(\/?)private\s*>/gi;

export function stripPrivateContent(content: string): string {
  if (!content.includes("<")) return content;

  let result = "";
  let depth = 0;
  let cursor = 0;

  PRIVATE_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = PRIVATE_TAG.exec(content)) !== null) {
    const isClosing = match[1] === "/";

    if (!isClosing) {
      if (depth === 0) result += content.slice(cursor, match.index);
      depth++;
      cursor = PRIVATE_TAG.lastIndex;
      continue;
    }

    if (depth === 0) {
      result += content.slice(cursor, match.index);
      cursor = PRIVATE_TAG.lastIndex;
      continue;
    }

    depth--;
    if (depth === 0) result += REDACTED;
    cursor = PRIVATE_TAG.lastIndex;
  }

  if (depth > 0) return result + REDACTED;
  return result + content.slice(cursor);
}

export function isFullyPrivate(content: string): boolean {
  const stripped = stripPrivateContent(content).trim();
  return stripped === REDACTED || stripped === "";
}
