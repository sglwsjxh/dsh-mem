// 连接管理器：按路径复用 Turso 连接，路径限制在存储目录内
import { connect, type Database } from "@tursodatabase/database";
import type { DatabaseOpts, EncryptionOpts } from "@tursodatabase/database-common";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, sep } from "node:path";
import { getConfig } from "../../config.js";
import { resolveDatabaseEncryption } from "./encryption-key.js";
import { collectReleasedSqliteHandles } from "./sqlite-handle-release.js";
import { TursoDb } from "./turso-db.js";

export type ConnectFactory = (path: string, opts?: DatabaseOpts) => Promise<Database>;

/** 多进程 WAL 仅 Unix 支持；Windows 单进程 */
export function supportsTursoMultiprocessWal(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/** 每次 Turso open 必开的实验特性 */
export function tursoExperimentalFeatures(
  platform: NodeJS.Platform = process.platform
): Array<"encryption" | "multiprocess_wal"> {
  if (supportsTursoMultiprocessWal(platform)) return ["encryption", "multiprocess_wal"];
  return ["encryption"];
}

function assertPathInsideStorage(dbPath: string): void {
  const storageRoot = resolve(getConfig().dataPath);
  const resolvedPath = resolve(dbPath);
  const relativePath = relative(storageRoot, resolvedPath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Refusing to open database outside dataPath: ${dbPath}`);
  }
}

export function buildConnectOptions(encryption?: EncryptionOpts | null): DatabaseOpts {
  const opts: DatabaseOpts = { experimental: tursoExperimentalFeatures() };
  if (encryption) opts.encryption = encryption;
  return opts;
}

const LOCK_ERROR_RE =
  /File is locked by another process|already open (with|without) experimental multiprocess WAL|Locking error/i;

export function isTursoMultiProcessLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return LOCK_ERROR_RE.test(message);
}

export function wrapTursoOpenError(dbPath: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (isTursoMultiProcessLockError(error)) {
    const platformHint =
      process.platform === "win32"
        ? "Windows 下 Turso 引擎仅允许一个进程持有数据库，请关闭其他会话后重试"
        : "其他进程仍持有数据库，请关闭后重试";
    return new Error(`Failed to open database ${dbPath}: ${message}. ${platformHint}`, { cause: error });
  }
  return error instanceof Error ? error : new Error(message, { cause: error });
}

export class TursoConnectionManager {
  private readonly connections = new Map<string, TursoDb>();
  private readonly pending = new Map<string, Promise<TursoDb>>();
  private readonly closingConnections = new Map<string, Promise<void>>();
  private closingPromise: Promise<void> | null = null;

  constructor(private readonly connectFactory: ConnectFactory = connect) {}

  async getConnection(dbPath: string): Promise<TursoDb> {
    if (this.closingPromise) await this.closingPromise;
    const closingConnection = this.closingConnections.get(dbPath);
    if (closingConnection) await closingConnection;
    assertPathInsideStorage(dbPath);

    const existing = this.connections.get(dbPath);
    if (existing) return existing;

    const inFlight = this.pending.get(dbPath);
    if (inFlight) return inFlight;

    const openPromise = (async (): Promise<TursoDb> => {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const encryption = resolveDatabaseEncryption();
      const opts = buildConnectOptions(encryption);
      let database: Database | null = null;
      try {
        database = await this.connectFactory(dbPath, opts);
        const db = new TursoDb(database);
        await db.execute("PRAGMA foreign_keys = ON");
        this.connections.set(dbPath, db);
        return db;
      } catch (error) {
        if (database) {
          try {
            await database.close();
          } catch {
            // 清理期关闭失败可忽略
          }
        }
        if (encryption) {
          const message = error instanceof Error ? error.message : String(error);
          if (isTursoMultiProcessLockError(error)) throw wrapTursoOpenError(dbPath, error);
          throw new Error(
            `Failed to open encrypted database ${dbPath}: ${message}. ` +
              `请检查 databaseEncryptionKey 配置，或关闭加密以使用明文分片`,
            { cause: error }
          );
        }
        throw wrapTursoOpenError(dbPath, error);
      }
    })();

    this.pending.set(dbPath, openPromise);
    try {
      return await openPromise;
    } catch (error) {
      this.connections.delete(dbPath);
      throw error;
    } finally {
      this.pending.delete(dbPath);
    }
  }

  async closeConnection(dbPath: string): Promise<void> {
    if (this.closingPromise) await this.closingPromise;
    const existingClose = this.closingConnections.get(dbPath);
    if (existingClose) return existingClose;

    const closePromise = Promise.resolve()
      .then(async () => {
        const pending = this.pending.get(dbPath);
        if (pending) await Promise.allSettled([pending]);

        const db = this.connections.get(dbPath);
        if (db) {
          try {
            await db.close();
          } catch (error) {
            console.error("Error closing Turso database", dbPath, String(error));
          }
          this.connections.delete(dbPath);
        }
        await collectReleasedSqliteHandles();
      })
      .finally(() => {
        this.closingConnections.delete(dbPath);
      });

    this.closingConnections.set(dbPath, closePromise);
    return closePromise;
  }

  async closeAll(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closingPromise = (async () => {
      await Promise.allSettled([...this.pending.values(), ...this.closingConnections.values()]);
      for (const [path, db] of this.connections) {
        try {
          await db.close();
        } catch (error) {
          console.error("Error closing Turso database", path, String(error));
        }
      }
      this.connections.clear();
      this.pending.clear();
      await collectReleasedSqliteHandles();
    })();
    try {
      await this.closingPromise;
    } finally {
      this.closingPromise = null;
    }
  }

  closeAllSync(): void {
    for (const [path, db] of this.connections) {
      try {
        void db.close();
      } catch (error) {
        console.error("Error closing Turso database", path, String(error));
      }
    }
    this.connections.clear();
    this.pending.clear();
  }
}

export const tursoConnectionManager = new TursoConnectionManager();
