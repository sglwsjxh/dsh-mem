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
    // 损坏的锁视为陈旧，走清理
  }
  try {
    unlinkSync(path);
  } catch {
    // 竞争或被占用，锁已无效，不阻塞写入
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
