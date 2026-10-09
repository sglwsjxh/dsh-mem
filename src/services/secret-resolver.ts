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

// 密钥解析：明文 env file 三种格式
import { readFileSync } from "node:fs";

export function resolveSecretValue(value: string | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("env://")) {
    const name = trimmed.slice(6);
    if (!name) return undefined;
    return process.env[name];
  }

  if (trimmed.startsWith("file://")) {
    const path = trimmed.slice(7);
    try {
      return readFileSync(path, "utf-8").trim();
    } catch {
      return undefined;
    }
  }

  return trimmed;
}
