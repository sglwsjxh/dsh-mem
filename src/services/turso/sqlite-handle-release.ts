// SQLite 文件副作用处理：WAL/SHM 同步搬运与 Windows 句柄重试
import { copyFileSync, existsSync, renameSync, unlinkSync } from "node:fs";

type RuntimeWithGarbageCollector = typeof globalThis & { gc?: () => void };

const GC_PASSES = 3;
const FILE_LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1600, 3200];
export const RETRYABLE_FILE_LOCK_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

const SQLITE_SIDE_SUFFIXES = ["-wal", "-shm", "-tshm"] as const;

/** 重命名数据库文件并同步搬运 WAL/SHM 副本，避免丢提交 */
export function renameSqliteDatabase(fromPath: string, toPath: string): void {
  renameSync(fromPath, toPath);
  for (const suffix of SQLITE_SIDE_SUFFIXES) {
    const fromSide = `${fromPath}${suffix}`;
    const toSide = `${toPath}${suffix}`;
    if (existsSync(toSide)) unlinkSync(toSide);
    if (existsSync(fromSide)) renameSync(fromSide, toSide);
  }
}

/** 复制数据库文件并同步复制 WAL/SHM 副本 */
export function copySqliteDatabase(fromPath: string, toPath: string): void {
  copyFileSync(fromPath, toPath);
  for (const suffix of SQLITE_SIDE_SUFFIXES) {
    const fromSide = `${fromPath}${suffix}`;
    const toSide = `${toPath}${suffix}`;
    if (existsSync(toSide)) unlinkSync(toSide);
    if (existsSync(fromSide)) copyFileSync(fromSide, toSide);
  }
}

/** 删除数据库文件及全部副作用文件 */
export function removeSqliteDatabase(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-tshm`]) {
    if (existsSync(path)) unlinkSync(path);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Windows 上句柄延迟释放，交换文件前强制回收 */
export async function collectReleasedSqliteHandles(): Promise<void> {
  if (process.platform !== "win32") return;
  const globalGc = (globalThis as RuntimeWithGarbageCollector).gc;
  if (!globalGc) return;
  for (let pass = 0; pass < GC_PASSES; pass += 1) {
    globalGc();
    await delay(0);
  }
}

/** Windows 文件操作重试，句柄未释放时按退避表等待 */
export async function withSqliteFileLockRetry<T>(
  operation: () => T | Promise<T>,
  maxRetries: number = FILE_LOCK_RETRY_DELAYS_MS.length
): Promise<T> {
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError("maxRetries must be a non-negative integer");
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const retryDelay = FILE_LOCK_RETRY_DELAYS_MS[attempt];
      if (
        process.platform !== "win32" ||
        !code ||
        !RETRYABLE_FILE_LOCK_CODES.has(code) ||
        retryDelay === undefined ||
        attempt >= maxRetries
      ) {
        throw error;
      }
      await collectReleasedSqliteHandles();
      await delay(retryDelay);
    }
  }
}
