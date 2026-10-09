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

// 操作锁：迁移类操作互斥，写入前检查
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../../config.js";

const OPERATION_LOCK = ".turso-operation.lock";

interface LockState {
  pid: number;
  timestamp: string;
  operation?: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLiveLock(path: string): LockState | null {
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf-8")) as LockState;
    if (Number.isInteger(state.pid) && state.pid > 0 && isProcessAlive(state.pid)) {
      return state;
    }
  } catch {
    // 锁损坏按陈旧处理
  }
  try {
    unlinkSync(path);
  } catch {
    // 竞争失败不阻塞写入
  }
  return null;
}

export function assertNoTursoMigrationInProgress(): void {
  const path = join(getConfig().dataPath, OPERATION_LOCK);
  const state = readLiveLock(path);
  if (state) {
    throw new Error(
      `Database migration is in progress${state.operation ? ` (${state.operation})` : ""} ` +
        `in process ${state.pid}; writes are temporarily blocked`
    );
  }
}

export function acquireTursoOperationLock(operation: string): () => void {
  assertNoTursoMigrationInProgress();
  const path = join(getConfig().dataPath, OPERATION_LOCK);
  const state: LockState = {
    pid: process.pid,
    timestamp: new Date().toISOString(),
    operation,
  };
  writeFileSync(path, JSON.stringify(state), { flag: "wx" });

  return () => {
    const current = readLiveLock(path);
    if (current?.pid === process.pid && existsSync(path)) {
      unlinkSync(path);
    }
  };
}
