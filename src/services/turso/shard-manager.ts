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

// 分片管理：注册表、分片轮换、写锁与向量计数
import { join, basename, resolve, relative } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { getConfig } from "../../config.js";
import { assertSafeScopeHash } from "../memory-scope.js";
import { tursoConnectionManager } from "./connection-manager.js";
import { assertNoTursoMigrationInProgress } from "./operation-lock.js";
import { withSqliteFileLockRetry } from "./sqlite-handle-release.js";
import type { ShardInfo } from "./types.js";
import type { TursoDb } from "./turso-db.js";
import { applySchemaMigrations, METADATA_DB_MIGRATIONS, memoryShardMigrations } from "./schema-migrations.js";

const METADATA_DB_NAME = "metadata.db";

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed") || message.includes("SQLITE_CONSTRAINT");
}

export class TursoShardManager {
  private metadataDb: TursoDb | null = null;
  private metadataPath = "";
  private initPromise: Promise<void> | null = null;
  private readonly writeLocks = new Map<string, Promise<unknown>>();

  reset(): void {
    this.metadataDb = null;
    this.initPromise = null;
    this.metadataPath = "";
    this.writeLocks.clear();
  }

  /** 同 scope 写入串行化，避免分片轮换竞争 */
  async withScopeWriteLock<T>(scope: "user" | "project", scopeHash: string, fn: () => Promise<T>): Promise<T> {
    const key = `${scope}:${scopeHash}`;
    const previous = this.writeLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const next = previous.catch(() => undefined).then(() => gate);
    this.writeLocks.set(key, next);

    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.writeLocks.get(key) === next) {
        this.writeLocks.delete(key);
      }
    }
  }

  private async ensureInitialized(): Promise<TursoDb> {
    this.metadataPath = join(getConfig().dataPath, METADATA_DB_NAME);

    if (this.initPromise) await this.initPromise;
    if (this.metadataDb) return this.metadataDb;

    this.initPromise = (async () => {
      try {
        this.metadataDb = await tursoConnectionManager.getConnection(this.metadataPath);
        await applySchemaMigrations(this.metadataDb, METADATA_DB_MIGRATIONS, { label: "metadata.db" });
      } catch (error) {
        this.initPromise = null;
        this.metadataDb = null;
        throw error;
      }
    })();

    await this.initPromise;
    return this.metadataDb!;
  }

  getShardPath(scope: "user" | "project", scopeHash: string, shardIndex: number): string {
    assertSafeScopeHash(scopeHash);
    const scopeDir = resolve(getConfig().dataPath, `${scope}s`);
    const fullPath = resolve(join(scopeDir, `${scope}_${scopeHash}_shard_${shardIndex}.db`));
    const relativePath = relative(scopeDir, fullPath);
    if (relativePath.startsWith("..") || relativePath.includes("..")) {
      throw new Error(`Shard path escapes storage directory: ${fullPath}`);
    }
    return fullPath;
  }

  private resolveStoredPath(storedPath: string, scope: string): string {
    const fileName = basename(storedPath);
    return join(getConfig().dataPath, `${scope}s`, fileName);
  }

  async getActiveShard(scope: "user" | "project", scopeHash: string): Promise<ShardInfo | null> {
    const metadataDb = await this.ensureInitialized();
    const row = await metadataDb.get(
      `
      SELECT * FROM shards
      WHERE scope = ? AND scope_hash = ? AND is_active = 1
      ORDER BY shard_index DESC LIMIT 1
    `,
      [scope, scopeHash]
    );
    if (!row) return null;
    return this.rowToShardInfo(row);
  }

  async getAllShards(scope: "user" | "project", scopeHash: string): Promise<ShardInfo[]> {
    const metadataDb = await this.ensureInitialized();
    const rows =
      scopeHash === ""
        ? await metadataDb.all(
            `
          SELECT * FROM shards
          WHERE scope = ?
          ORDER BY shard_index ASC
        `,
            [scope]
          )
        : await metadataDb.all(
            `
          SELECT * FROM shards
          WHERE scope = ? AND scope_hash = ?
          ORDER BY shard_index ASC
        `,
            [scope, scopeHash]
          );
    return rows.map((row) => this.rowToShardInfo(row));
  }

  async createShard(scope: "user" | "project", scopeHash: string, shardIndex: number): Promise<ShardInfo> {
    const metadataDb = await this.ensureInitialized();
    const fullPath = this.getShardPath(scope, scopeHash, shardIndex);
    const storedPath = join(`${scope}s`, basename(fullPath)).replace(/\\/g, "/");
    const now = Date.now();

    // 先建文件再写注册行，避免孤儿行指向空文件
    const shardDb = await tursoConnectionManager.getConnection(fullPath);
    await this.initShardDb(shardDb);

    let result;
    try {
      result = await metadataDb.execute(
        `
      INSERT INTO shards (scope, scope_hash, shard_index, db_path, vector_count, is_active, created_at)
      VALUES (?, ?, ?, ?, 0, 1, ?)
    `,
        [scope, scopeHash, shardIndex, storedPath, now]
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existing = await metadataDb.get(
          `
          SELECT * FROM shards
          WHERE scope = ? AND scope_hash = ? AND shard_index = ?
        `,
          [scope, scopeHash, shardIndex]
        );
        if (existing) return this.rowToShardInfo(existing);
      }
      throw error;
    }

    return {
      id: Number(result.lastInsertRowid),
      scope,
      scopeHash,
      shardIndex,
      dbPath: fullPath,
      vectorCount: 0,
      isActive: true,
      createdAt: now,
    };
  }

  async registerExistingShard(
    scope: "user" | "project",
    scopeHash: string,
    shardIndex: number,
    dbPath: string,
    vectorCount: number,
    isActive: boolean
  ): Promise<ShardInfo> {
    assertSafeScopeHash(scopeHash);
    const metadataDb = await this.ensureInitialized();
    const storedPath = join(`${scope}s`, basename(dbPath)).replace(/\\/g, "/");
    const now = Date.now();

    await metadataDb.execute(
      `
        INSERT INTO shards (
          scope, scope_hash, shard_index, db_path, vector_count, is_active, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope, scope_hash, shard_index) DO UPDATE SET
          db_path = excluded.db_path,
          vector_count = excluded.vector_count,
          is_active = excluded.is_active
      `,
      [scope, scopeHash, shardIndex, storedPath, vectorCount, isActive ? 1 : 0, now]
    );

    const row = await metadataDb.get(
      `SELECT * FROM shards WHERE scope = ? AND scope_hash = ? AND shard_index = ?`,
      [scope, scopeHash, shardIndex]
    );
    if (!row) throw new Error(`Failed to register shard ${scope}/${scopeHash}#${shardIndex}`);
    return this.rowToShardInfo(row);
  }

  /** dimensions 可空，自动探测模式；初始化必须确定值 */
  private resolveDimensions(explicit?: number): number {
    const dims = explicit ?? getConfig().embedding.dimensions;
    if (dims === undefined) {
      throw new Error("embedding.dimensions 未配置且尚无自动探测值；分片初始化需要确定维度");
    }
    if (!Number.isInteger(dims) || dims <= 0 || dims > 65536) {
      throw new Error(`Invalid embedding dimensions config: ${dims}`);
    }
    return dims;
  }

  async initShardDb(db: TursoDb, dimensions?: number): Promise<void> {
    const dims = this.resolveDimensions(dimensions);
    await applySchemaMigrations(db, memoryShardMigrations(dims), { label: "memory-shard" });

    await db.batch([
      {
        sql: `INSERT OR REPLACE INTO shard_metadata (key, value) VALUES ('embedding_dimensions', ?)`,
        args: [String(dims)],
      },
      {
        // key 名沿用 embedding_type，避免 schema 迁移
        sql: `INSERT OR REPLACE INTO shard_metadata (key, value) VALUES ('embedding_type', ?)`,
        args: [getConfig().embedding.model],
      },
    ]);
  }

  /** 应用分片迁移，不重写 shard_metadata */
  async ensureShardSchema(db: TursoDb, dimensions?: number): Promise<void> {
    const dims = this.resolveDimensions(dimensions);
    await applySchemaMigrations(db, memoryShardMigrations(dims), { label: "memory-shard" });
  }

  private rowToShardInfo(row: Record<string, unknown>): ShardInfo {
    return {
      id: Number(row.id),
      scope: row.scope as "user" | "project",
      scopeHash: String(row.scope_hash),
      shardIndex: Number(row.shard_index),
      dbPath: this.resolveStoredPath(String(row.db_path), String(row.scope)),
      vectorCount: Number(row.vector_count),
      isActive: Number(row.is_active) === 1,
      createdAt: Number(row.created_at),
    };
  }

  private async hasMatchingEmbeddingDimensions(db: TursoDb, shard: ShardInfo): Promise<boolean> {
    const row = await db.get(`SELECT value FROM shard_metadata WHERE key = 'embedding_dimensions'`);
    if (!row?.value) return false;

    const storedDimensions = Number(row.value);
    if (storedDimensions !== this.resolveDimensions()) return false;
    return true;
  }

  private async syncShardVectorCount(shard: ShardInfo): Promise<ShardInfo> {
    const db = await tursoConnectionManager.getConnection(shard.dbPath);
    const row = await db.get(`SELECT COUNT(*) as count FROM memories`);
    const count = Number(row?.count ?? 0);
    if (count === shard.vectorCount) return shard;

    const metadataDb = await this.ensureInitialized();
    await metadataDb.run(`UPDATE shards SET vector_count = ? WHERE id = ?`, [count, shard.id]);
    return { ...shard, vectorCount: count };
  }

  private async isShardValid(shard: ShardInfo): Promise<boolean> {
    if (!existsSync(shard.dbPath)) return false;

    try {
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const result = await db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='memories'`);
      if (!result) return false;
      return await this.hasMatchingEmbeddingDimensions(db, shard);
    } catch {
      return false;
    }
  }

  async getWriteShard(scope: "user" | "project", scopeHash: string): Promise<ShardInfo> {
    assertNoTursoMigrationInProgress();
    for (let attempt = 0; attempt < 3; attempt++) {
      let shard = await this.getActiveShard(scope, scopeHash);

      if (!shard) return this.createShard(scope, scopeHash, 0);

      if (!(await this.isShardValid(shard))) {
        throw new Error(
          `Shard ${shard.scope}/${shard.scopeHash}#${shard.shardIndex} is incompatible or corrupt. ` +
            `原数据库保留在 ${shard.dbPath}，请先迁移或恢复后再写入`
        );
      }

      shard = await this.syncShardVectorCount(shard);

      if (shard.vectorCount >= getConfig().maxVectorsPerShard) {
        await this.markShardReadOnly(shard.id);
        return this.createShard(scope, scopeHash, shard.shardIndex + 1);
      }

      return shard;
    }

    throw new Error(`Failed to resolve write shard for ${scope}/${scopeHash}`);
  }

  private async markShardReadOnly(shardId: number): Promise<void> {
    const metadataDb = await this.ensureInitialized();
    await metadataDb.run(`UPDATE shards SET is_active = 0 WHERE id = ?`, [shardId]);
  }

  async incrementVectorCount(shardId: number): Promise<void> {
    const metadataDb = await this.ensureInitialized();
    await metadataDb.run(`UPDATE shards SET vector_count = vector_count + 1 WHERE id = ?`, [shardId]);
  }

  async decrementVectorCount(shardId: number): Promise<void> {
    const metadataDb = await this.ensureInitialized();
    await metadataDb.run(
      `UPDATE shards SET vector_count = vector_count - 1 WHERE id = ? AND vector_count > 0`,
      [shardId]
    );
  }

  async setVectorCount(shardId: number, count: number): Promise<void> {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`Invalid vector count: ${count}`);
    }
    const metadataDb = await this.ensureInitialized();
    await metadataDb.run(`UPDATE shards SET vector_count = ? WHERE id = ?`, [count, shardId]);
  }

  async getShardById(shardId: number): Promise<ShardInfo | null> {
    const metadataDb = await this.ensureInitialized();
    const row = await metadataDb.get(`SELECT * FROM shards WHERE id = ?`, [shardId]);
    return row ? this.rowToShardInfo(row) : null;
  }

  async deleteShard(shardId: number): Promise<void> {
    const metadataDb = await this.ensureInitialized();
    const row = await metadataDb.get(`SELECT * FROM shards WHERE id = ?`, [shardId]);
    if (!row) return;

    const fullPath = this.resolveStoredPath(String(row.db_path), String(row.scope));
    await tursoConnectionManager.closeConnection(fullPath);

    try {
      if (existsSync(fullPath)) {
        await withSqliteFileLockRetry(() => unlinkSync(fullPath));
      }
    } catch (error) {
      console.error("Error deleting shard file", fullPath, String(error));
    }

    await metadataDb.run(`DELETE FROM shards WHERE id = ?`, [shardId]);
  }

  /**
   * 分片改挂到新 scope hash 与文件名
   * 调用方必须先关连接并改好文件名
   */
  async reassignShardScope(
    shardId: number,
    newScopeHash: string,
    newDbPath: string,
    vectorCount: number,
    isActive: boolean
  ): Promise<ShardInfo> {
    assertSafeScopeHash(newScopeHash);
    const metadataDb = await this.ensureInitialized();
    const row = await metadataDb.get(`SELECT * FROM shards WHERE id = ?`, [shardId]);
    if (!row) throw new Error(`Shard ${shardId} not found in metadata registry`);

    const scope = String(row.scope) as "user" | "project";
    const storedPath = join(`${scope}s`, basename(newDbPath)).replace(/\\/g, "/");

    await metadataDb.run(
      `
      UPDATE shards
      SET scope_hash = ?, db_path = ?, vector_count = ?, is_active = ?
      WHERE id = ?
    `,
      [newScopeHash, storedPath, vectorCount, isActive ? 1 : 0, shardId]
    );

    const updated = await metadataDb.get(`SELECT * FROM shards WHERE id = ?`, [shardId]);
    if (!updated) throw new Error(`Failed to reassign shard ${shardId}`);
    return this.rowToShardInfo(updated);
  }
}

export const tursoShardManager = new TursoShardManager();
