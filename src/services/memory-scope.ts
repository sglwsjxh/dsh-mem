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

// 容器标签与 scope 解析：prefix_scope_16hex
export const SCOPE_HASH_PATTERN = /^[a-f0-9]{16}$/;

export function isValidScopeHash(hash: string): boolean {
  return SCOPE_HASH_PATTERN.test(hash);
}

export function assertSafeScopeHash(scopeHash: string): void {
  if (!isValidScopeHash(scopeHash)) {
    throw new Error(`Invalid scope hash: expected 16 lowercase hex characters, got "${scopeHash}"`);
  }
}

export function extractScopeFromContainerTag(containerTag: string): {
  scope: "user" | "project";
  hash: string;
} {
  const parts = containerTag.split("_");
  if (parts.length < 3) {
    throw new Error(
      `Invalid containerTag: expected format {prefix}_{user|project}_{16hex}, got "${containerTag}"`
    );
  }

  const hash = parts[parts.length - 1]!;
  const scope = parts[parts.length - 2]!;

  if (scope !== "user" && scope !== "project") {
    throw new Error(`Invalid containerTag scope: "${scope}" in "${containerTag}"`);
  }

  if (!isValidScopeHash(hash)) {
    throw new Error(`Invalid containerTag hash: expected 16 lowercase hex characters in "${containerTag}"`);
  }

  return { scope, hash };
}

export function tryExtractScopeFromContainerTag(
  containerTag: string
): { scope: "user" | "project"; hash: string } | null {
  try {
    return extractScopeFromContainerTag(containerTag);
  } catch {
    return null;
  }
}

export interface MemoryScopeRef {
  scope: "user" | "project";
  hash: string;
}

/** all 跨 user 与 project 两个 scope 检索 */
export function resolveMemoryScope(
  scope: "project" | "all",
  containerTag: string
): MemoryScopeRef[] {
  if (scope === "all") {
    return [
      { scope: "user", hash: "" },
      { scope: "project", hash: "" },
    ];
  }
  return [extractScopeFromContainerTag(containerTag)];
}
