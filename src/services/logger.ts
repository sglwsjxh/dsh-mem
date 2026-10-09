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

// 极简日志，不依赖宿主 cordis
type LogArgs = Record<string, unknown> | undefined;

function format(args: LogArgs): string {
  if (!args) return "";
  try {
    return " " + JSON.stringify(args);
  } catch {
    return "";
  }
}

export function log(message: string, args?: LogArgs): void {
  const line = `[dsh-mem] ${message}${format(args)}`;
  if (process.env.DSH_MEM_DEBUG) {
    console.error(line);
  }
}
