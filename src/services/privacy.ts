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

// 隐私过滤：private 区域替换为 REDACTED
// 未闭合的闭合到末尾，嵌套的闭合到外层
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
