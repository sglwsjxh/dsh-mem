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

// 存储层门面，嵌入依赖构造注入
import { getConfig } from "../config.js";
import type { Embedder, MemoryRecord, MemorySearchResult } from "../types.js";
import { log } from "./logger.js";
import { extractScopeFromContainerTag, resolveMemoryScope, type MemoryScopeRef } from "./memory-scope.js";
import { ensureTursoReady } from "./turso/ready.js";
import { tursoShardManager } from "./turso/shard-manager.js";
import { tursoConnectionManager } from "./turso/connection-manager.js";
import { tursoVectorSearch } from "./turso/vector-search.js";
import { formatTagsForEmbedding, blobToFloat32Array } from "./turso/vector-utils.js";
import type { StoredMemory } from "./turso/types.js";
import { closeTursoAndInvalidateCaches } from "./turso/lifecycle.js";
import { exportMemories, importMemories, type ExportMemoriesOptions, type ExportMemoriesResult, type ImportMemoriesOptions, type ImportMemoriesResult } from "./portability.js";

import type { MemoryScope } from "../types.js";

export interface AddMemoryMetadata {
  type?: string;
  source?: "manual" | "auto-capture" | "import" | "api";
  tags?: string[];
  sessionId?: string;
  promptId?: string;
  captureTimestamp?: number;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
  [key: string]: unknown;
}

export interface ListShardsResult {
  success: boolean;
  storagePath?: string;
  currentProject?: { tag: string; scopeHash: string; projectPath: string };
  shards?: Array<{
    id: number;
    scope: string;
    scopeHash: string;
    shardIndex: number;
    dbPath: string;
    vectorCount: number;
    isActive: boolean;
    fileExists: boolean;
  }>;
  error?: string;
}

export interface MigrateProjectPathOptions {
  currentDirectory: string;
  fromPath?: string;
  fromHash?: string;
  dryRun?: boolean;
  allowLinkedSource?: boolean;
}

export interface MigrateProjectPathResult {
  success: boolean;
  dryRun: boolean;
  migratedMemories?: number;
  oldHash?: string;
  newHash?: string;
  error?: string;
}

function safeJSONParse(jsonString: unknown): Record<string, unknown> | undefined {
  if (!jsonString || typeof jsonString !== "string") return undefined;
  try {
    return JSON.parse(jsonString) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function toMemoryRecord(row: Record<string, unknown>): MemoryRecord {
  const tagsStr = row.tags ? String(row.tags) : "";
  const metadata = safeJSONParse(row.metadata);
  return {
    id: String(row.id),
    content: String(row.content),
    containerTag: String(row.container_tag),
    tags: tagsStr ? tagsStr.split(",") : [],
    type: row.type ? String(row.type) : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at ?? row.created_at),
    sessionId: row.session_id ? String(row.session_id) : undefined,
    metadata,
    displayName: row.display_name ? String(row.display_name) : undefined,
    userName: row.user_name ? String(row.user_name) : undefined,
    userEmail: row.user_email ? String(row.user_email) : undefined,
    projectPath: row.project_path ? String(row.project_path) : undefined,
    projectName: row.project_name ? String(row.project_name) : undefined,
    gitRepoUrl: row.git_repo_url ? String(row.git_repo_url) : undefined,
    isPinned: Number(row.is_pinned ?? 0) === 1,
  };
}

function resolveScopeValue(scope: MemoryScope, containerTag: string): MemoryScopeRef[] {
  return resolveMemoryScope(scope, containerTag);
}

export class LocalMemoryClient {
  private initPromise: Promise<void> | null = null;
  private isInitialized = false;

  constructor(private readonly embedder: Embedder) {}

  private async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        await ensureTursoReady();
        this.isInitialized = true;
      } catch (error) {
        this.initPromise = null;
        log("Turso initialization failed", { error: String(error) });
        throw error;
      }
    })();

    return this.initPromise;
  }

  async warmup(): Promise<void> {
    await this.initialize();
    await this.embedder.warmup();
  }

  isReady(): boolean {
    return this.isInitialized && this.embedder.isReady();
  }

  getEmbeddingInitError(): string | null {
    return this.embedder.initError;
  }

  async ensureStorageReady(): Promise<void> {
    await this.initialize();
  }

  getStatus(): {
    dbConnected: boolean;
    modelLoaded: boolean;
    ready: boolean;
    embeddingError: string | null;
  } {
    return {
      dbConnected: this.isInitialized,
      modelLoaded: this.embedder.isReady(),
      ready: this.isInitialized && this.embedder.isReady(),
      embeddingError: this.embedder.initError,
    };
  }

  reset(): void {
    this.isInitialized = false;
    this.initPromise = null;
  }

  async close(): Promise<void> {
    await closeTursoAndInvalidateCaches();
    this.reset();
  }

  async searchMemories(query: string, containerTag: string, scope: MemoryScope = "project") {
    try {
      await this.initialize();

      const queryVector = await this.embedder.embed(query);
      const resolved = resolveScopeValue(scope, containerTag);
      const shards = (
        await Promise.all(resolved.map((ref) => tursoShardManager.getAllShards(ref.scope, ref.hash)))
      ).flat();

      if (shards.length === 0) return { success: true as const, results: [] as MemorySearchResult[] };

      const { results, warnings } = await tursoVectorSearch.searchAcrossShards(
        shards,
        queryVector,
        scope === "all" ? "" : containerTag,
        getConfig().maxMemories,
        getConfig().similarityThreshold,
        query
      );

      return {
        success: true as const,
        results,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("searchMemories: error", { error: errorMessage });
      return { success: false as const, error: errorMessage, results: [] as MemorySearchResult[] };
    }
  }

  async addMemory(content: string, containerTag: string, metadata?: AddMemoryMetadata) {
    try {
      await this.initialize();

      const tags = metadata?.tags ?? [];
      const vector = await this.embedder.embed(content);
      let tagsVector: Float32Array | undefined;
      if (tags.length > 0) {
        tagsVector = await this.embedder.embed(formatTagsForEmbedding(tags));
      }

      const { scope, hash } = extractScopeFromContainerTag(containerTag);

      return await tursoShardManager.withScopeWriteLock(scope, hash, async () => {
        const shard = await tursoShardManager.getWriteShard(scope, hash);

        const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
        const now = Date.now();

        const {
          displayName,
          userName,
          userEmail,
          projectPath,
          projectName,
          gitRepoUrl,
          type,
          source,
          tags: _tags,
          sessionId,
          promptId,
          captureTimestamp,
          ...dynamicMetadata
        } = metadata ?? {};

        // sessionId 同时落独立列与 metadata，兼容两条检索路径
        const metadataJson: Record<string, unknown> = { ...dynamicMetadata };
        if (sessionId) metadataJson.sessionID = sessionId;
        if (source) metadataJson.source = source;
        if (promptId) metadataJson.promptId = promptId;
        if (captureTimestamp !== undefined) metadataJson.captureTimestamp = captureTimestamp;

        const record: StoredMemory = {
          id,
          content,
          vector,
          tagsVector,
          containerTag,
          tags: tags.length > 0 ? tags.join(",") : undefined,
          type,
          createdAt: now,
          updatedAt: now,
          displayName,
          userName,
          userEmail,
          projectPath,
          projectName,
          gitRepoUrl,
          sessionId,
          metadata: Object.keys(metadataJson).length > 0 ? JSON.stringify(metadataJson) : undefined,
        };

        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        await tursoVectorSearch.insertVector(db, record);
        await tursoShardManager.incrementVectorCount(shard.id);

        return { success: true as const, id };
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("addMemory: error", { error: errorMessage });
      return { success: false as const, error: errorMessage };
    }
  }

  async deleteMemory(memoryId: string) {
    try {
      await this.initialize();

      const userShards = await tursoShardManager.getAllShards("user", "");
      const projectShards = await tursoShardManager.getAllShards("project", "");
      const allShards = [...userShards, ...projectShards];

      for (const shard of allShards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const memory = await tursoVectorSearch.getMemoryById(db, memoryId);

        if (memory) {
          await tursoVectorSearch.deleteVector(db, memoryId);
          await tursoShardManager.decrementVectorCount(shard.id);
          return { success: true as const };
        }
      }

      return { success: false as const, error: "Memory not found" };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("deleteMemory: error", { memoryId, error: errorMessage });
      return { success: false as const, error: errorMessage };
    }
  }

  async listMemories(containerTag: string, limit = 20, scope: MemoryScope = "project") {
    try {
      await this.initialize();

      const resolved = resolveScopeValue(scope, containerTag);
      const shards = (
        await Promise.all(resolved.map((ref) => tursoShardManager.getAllShards(ref.scope, ref.hash)))
      ).flat();

      if (shards.length === 0) return { success: true as const, memories: [] as MemoryRecord[] };

      const allMemories: Record<string, unknown>[] = [];

      for (const shard of shards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const memories = await tursoVectorSearch.listMemories(
          db,
          scope === "all" ? "" : containerTag,
          limit
        );
        allMemories.push(...memories);
      }

      allMemories.sort((a, b) => Number(b.created_at) - Number(a.created_at));
      const memories = allMemories.slice(0, limit).map(toMemoryRecord);

      return { success: true as const, memories };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("listMemories: error", { error: errorMessage });
      return { success: false as const, error: errorMessage, memories: [] as MemoryRecord[] };
    }
  }

  async searchMemoriesBySessionID(sessionId: string, containerTag: string, limit = 10) {
    try {
      await this.initialize();

      const { scope, hash } = extractScopeFromContainerTag(containerTag);
      const shards = await tursoShardManager.getAllShards(scope, hash);

      if (shards.length === 0) return { success: true as const, results: [] as MemorySearchResult[] };

      const allMemories: Record<string, unknown>[] = [];

      for (const shard of shards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const memories = await tursoVectorSearch.getMemoriesBySessionID(db, sessionId);
        allMemories.push(...memories);
      }

      allMemories.sort((a, b) => Number(b.created_at) - Number(a.created_at));

      const results: MemorySearchResult[] = allMemories.slice(0, limit).map((row) => ({
        id: String(row.id),
        memory: String(row.content),
        similarity: 1.0,
        createdAt: Number(row.created_at),
        tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
        metadata: safeJSONParse(row.metadata),
        containerTag: String(row.container_tag),
      }));

      return { success: true as const, results };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("searchMemoriesBySessionID: error", { error: errorMessage });
      return { success: false as const, error: errorMessage, results: [] as MemorySearchResult[] };
    }
  }

  async listShards(currentDirectory: string): Promise<ListShardsResult> {
    try {
      await this.initialize();
      const { getProjectTagInfo } = await import("./tags.js");
      const current = getProjectTagInfo(currentDirectory);
      const hash = current.tag.split("_").pop() ?? "";

      const registered = [
        ...(await tursoShardManager.getAllShards("user", hash)),
        ...(await tursoShardManager.getAllShards("project", hash)),
      ];

      const shards = [];
      for (const shard of registered) {
        let memoryCount = shard.vectorCount;
        try {
          if (await tursoShardManager.getActiveShard(shard.scope, shard.scopeHash)) {
            const db = await tursoConnectionManager.getConnection(shard.dbPath);
            memoryCount = await tursoVectorSearch.countAllVectors(db);
          }
        } catch {
          // 统计失败时退回注册计数
        }
        shards.push({
          id: shard.id,
          scope: shard.scope,
          scopeHash: shard.scopeHash,
          shardIndex: shard.shardIndex,
          dbPath: shard.dbPath,
          vectorCount: memoryCount,
          isActive: shard.isActive,
          fileExists: await import("node:fs").then((fs) => fs.existsSync(shard.dbPath)),
        });
      }

      return {
        success: true,
        storagePath: getConfig().dataPath,
        currentProject: {
          tag: current.tag,
          scopeHash: hash,
          projectPath: current.projectPath ?? currentDirectory,
        },
        shards,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("listShards: error", { error: errorMessage });
      return { success: false, error: errorMessage };
    }
  }

  /** 项目路径迁移：行级搬移，读源向量重打标签写目标分片再删源行，不做文件级 rename */
  async migrateProjectPath(options: MigrateProjectPathOptions): Promise<MigrateProjectPathResult> {
    try {
      await this.initialize();
      const { getProjectTagInfo } = await import("./tags.js");
      const target = getProjectTagInfo(options.currentDirectory);
      const newHash = extractScopeFromContainerTag(target.tag).hash;

      // 源 hash：显式 fromHash 优先，否则按存储的 project_path 匹配
      let oldHash = options.fromHash ?? null;
      if (!oldHash) {
        if (!options.fromPath) {
          return { success: false, dryRun: Boolean(options.dryRun), error: "fromPath or fromHash is required" };
        }
        oldHash = await this.findHashByProjectPath(options.fromPath);
        if (!oldHash) {
          return {
            success: false,
            dryRun: Boolean(options.dryRun),
            error: `No shard memories found for fromPath ${options.fromPath}`,
          };
        }
      }

      if (oldHash === newHash) {
        return { success: true, dryRun: Boolean(options.dryRun), oldHash, newHash, migratedMemories: 0 };
      }

      const sourceShards = await tursoShardManager.getAllShards("project", oldHash);
      if (sourceShards.length === 0) {
        return { success: false, dryRun: Boolean(options.dryRun), oldHash, newHash, error: `No shards for source hash ${oldHash}` };
      }

      // 收集源分片全部行与向量
      const rows: Array<Record<string, unknown>> = [];
      for (const shard of sourceShards) {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const shardRows = await db.all(`SELECT *, vector_extract(vector) AS vector_json FROM memories`);
        rows.push(...shardRows);
      }
      const migratedMemories = rows.length;
      if (migratedMemories === 0) {
        return { success: true, dryRun: Boolean(options.dryRun), oldHash, newHash, migratedMemories: 0 };
      }

      if (options.dryRun) {
        return { success: true, dryRun: true, oldHash, newHash, migratedMemories };
      }

      // 写入目标分片后删除源行
      return await tursoShardManager.withScopeWriteLock("project", newHash, async () => {
        let shard = await tursoShardManager.getActiveShard("project", newHash);
        if (!shard) shard = await tursoShardManager.createShard("project", newHash, 0);
        const db = await tursoConnectionManager.getConnection(shard.dbPath);

        await db.transaction("write", async (tx) => {
          for (const row of rows) {
            const vector = blobToFloat32Array(row.vector_json);
            if (!vector) throw new Error(`Failed to parse vector for memory ${String(row.id)}`);
            const record: StoredMemory = {
              id: String(row.id),
              content: String(row.content),
              vector,
              containerTag: target.tag,
              tags: row.tags ? String(row.tags) : undefined,
              type: row.type ? String(row.type) : undefined,
              createdAt: Number(row.created_at),
              updatedAt: Number(row.updated_at ?? row.created_at),
              metadata: row.metadata ? String(row.metadata) : undefined,
              sessionId: row.session_id ? String(row.session_id) : undefined,
              displayName: target.displayName,
              userName: row.user_name ? String(row.user_name) : undefined,
              userEmail: row.user_email ? String(row.user_email) : undefined,
              projectPath: target.projectPath,
              projectName: target.projectName,
              gitRepoUrl: target.gitRepoUrl,
            };
            await tursoVectorSearch.insertVectorInTransaction(tx, record);
          }
        });

        await tursoShardManager.setVectorCount(shard.id, await tursoVectorSearch.countAllVectors(db));

        for (const sourceShard of sourceShards) {
          const sourceDb = await tursoConnectionManager.getConnection(sourceShard.dbPath);
          await sourceDb.run(`DELETE FROM memories`);
          await tursoShardManager.setVectorCount(sourceShard.id, 0);
        }

        return { success: true as const, dryRun: false, oldHash, newHash, migratedMemories };
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log("migrateProjectPath: error", { error: errorMessage });
      return { success: false, dryRun: Boolean(options.dryRun), error: errorMessage };
    }
  }

  private async findHashByProjectPath(projectPath: string): Promise<string | null> {
    const { normalize } = await import("node:path");
    const normalizedTarget = normalize(projectPath).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const allShards = await tursoShardManager.getAllShards("project", "");

    for (const shard of allShards) {
      try {
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const counts = await tursoVectorSearch.getProjectPathCounts(db);
        for (const entry of counts) {
          const normalized = normalize(entry.projectPath).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
          if (normalized === normalizedTarget) {
            return shard.scopeHash;
          }
        }
      } catch {
        // 单分片读取失败继续找
      }
    }
    return null;
  }

  async exportMemories(options: ExportMemoriesOptions): Promise<ExportMemoriesResult> {
    return exportMemories(this.embedder, options);
  }

  async importMemories(options: ImportMemoriesOptions): Promise<ImportMemoriesResult> {
    return importMemories(this.embedder, options);
  }
}

/** 装配入口：宿主注入 embedding 服务实例 */
export function createLocalMemoryClient(embedder: Embedder): LocalMemoryClient {
  return new LocalMemoryClient(embedder);
}
