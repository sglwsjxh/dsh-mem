// 记忆导出导入：JSON 文档 + zod 校验，带隐私脱敏
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getConfig } from "../config.js";
import { extractScopeFromContainerTag } from "./memory-scope.js";
import { getProjectTagInfo } from "./tags.js";
import { ensureTursoReady } from "./turso/ready.js";
import { acquireTursoOperationLock } from "./turso/operation-lock.js";
import { tursoShardManager } from "./turso/shard-manager.js";
import { tursoConnectionManager } from "./turso/connection-manager.js";
import { tursoVectorSearch } from "./turso/vector-search.js";
import { formatTagsForEmbedding } from "./turso/vector-utils.js";
import type { StoredMemory } from "./turso/types.js";
import type { Embedder } from "../types.js";
import { stripPrivateContent, isFullyPrivate } from "./privacy.js";
import { log } from "./logger.js";

export const PORTABILITY_SCHEMA_VERSION = 1 as const;

export const ExportedMemorySchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative().optional(),
  isPinned: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  displayName: z.string().optional(),
  userName: z.string().optional(),
  userEmail: z.string().optional(),
  projectPath: z.string().optional(),
  projectName: z.string().optional(),
  gitRepoUrl: z.string().optional(),
});

export const MemoryExportDocumentSchema = z.object({
  schemaVersion: z.literal(PORTABILITY_SCHEMA_VERSION),
  exportedAt: z.string().min(1),
  plugin: z.object({
    package: z.string(),
    version: z.string(),
  }),
  source: z.object({
    containerTag: z.string().min(1),
    scope: z.literal("project"),
    scopeHash: z.string().regex(/^[a-f0-9]{16}$/),
    projectPath: z.string().optional(),
    projectName: z.string().optional(),
    gitRepoUrl: z.string().optional(),
  }),
  embedding: z.object({
    model: z.string(),
    dimensions: z.number().int().positive(),
  }),
  memories: z.array(ExportedMemorySchema),
});

export type ExportedMemory = z.infer<typeof ExportedMemorySchema>;
export type MemoryExportDocument = z.infer<typeof MemoryExportDocumentSchema>;

export interface ExportMemoriesOptions {
  currentDirectory: string;
  outputPath: string;
}

export interface ExportMemoriesResult {
  success: boolean;
  outputPath?: string;
  count?: number;
  containerTag?: string;
  scopeHash?: string;
  error?: string;
}

export interface ImportMemoriesOptions {
  currentDirectory: string;
  inputPath: string;
  dryRun?: boolean;
}

export interface ImportMemoriesResult {
  success: boolean;
  dryRun: boolean;
  imported?: number;
  skipped?: Array<{ id: string; reason: string }>;
  rejected?: Array<{ id: string; reason: string }>;
  containerTag?: string;
  error?: string;
}

const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

function getPluginVersion(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function describeEmbeddingModel(): string {
  const cfg = getConfig().embedding;
  return cfg.model || "unconfigured";
}

/** dimensions 未配置时回退 meta.json 的自动探测值 */
function resolveExportDimensions(): number {
  const cfg = getConfig().embedding;
  if (cfg.dimensions !== undefined) return cfg.dimensions;
  try {
    const metaPath = join(getConfig().dataPath, "meta.json");
    if (existsSync(metaPath)) {
      const parsed = JSON.parse(readFileSync(metaPath, "utf-8")) as { embeddingDimensions?: Record<string, number> };
      const dims = parsed.embeddingDimensions?.[cfg.model];
      if (typeof dims === "number" && Number.isInteger(dims) && dims > 0) return dims;
    }
  } catch {
    // meta.json 损坏视同无探测值
  }
  throw new Error("无法确定维度，请先完成一次嵌入或配置 embedding.dimensions");
}

function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function parseTags(value: unknown): string[] | undefined {
  if (!value || typeof value !== "string") return undefined;
  const tags = value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

function rowToExportedMemory(row: Record<string, unknown>): ExportedMemory | null {
  const rawContent = String(row.content ?? "");
  const content = stripPrivateContent(rawContent);
  if (!content.trim() || isFullyPrivate(rawContent)) return null;

  return {
    id: String(row.id),
    content,
    type: row.type ? String(row.type) : undefined,
    tags: parseTags(row.tags),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at ?? row.created_at),
    isPinned: Number(row.is_pinned ?? 0) === 1,
    metadata: parseMetadata(row.metadata),
    displayName: row.display_name ? String(row.display_name) : undefined,
    userName: row.user_name ? String(row.user_name) : undefined,
    userEmail: row.user_email ? String(row.user_email) : undefined,
    projectPath: row.project_path ? String(row.project_path) : undefined,
    projectName: row.project_name ? String(row.project_name) : undefined,
    gitRepoUrl: row.git_repo_url ? String(row.git_repo_url) : undefined,
  };
}

export async function exportMemories(
  _embedder: Embedder,
  options: ExportMemoriesOptions
): Promise<ExportMemoriesResult> {
  try {
    await ensureTursoReady();

    const outputPath = resolve(options.outputPath);
    const project = getProjectTagInfo(options.currentDirectory);
    const { hash: scopeHash } = extractScopeFromContainerTag(project.tag);
    const shards = await tursoShardManager.getAllShards("project", scopeHash);

    const memories: ExportedMemory[] = [];
    for (const shard of shards) {
      if (!existsSync(shard.dbPath)) continue;
      const db = await tursoConnectionManager.getConnection(shard.dbPath);
      const rows = await tursoVectorSearch.getAllMemories(db);
      for (const row of rows) {
        const exported = rowToExportedMemory(row);
        if (exported) memories.push(exported);
      }
    }

    memories.sort((a, b) => b.createdAt - a.createdAt);

    const document: MemoryExportDocument = {
      schemaVersion: PORTABILITY_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      plugin: { package: "dsh-mem", version: getPluginVersion() },
      source: {
        containerTag: project.tag,
        scope: "project",
        scopeHash,
        projectPath: project.projectPath,
        projectName: project.projectName,
        gitRepoUrl: project.gitRepoUrl,
      },
      embedding: {
        model: describeEmbeddingModel(),
        dimensions: resolveExportDimensions(),
      },
      memories,
    };

    // 写盘前先校验，保证不产出非法文档
    MemoryExportDocumentSchema.parse(document);

    mkdirSync(dirname(outputPath), { recursive: true });
    const tmpPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmpPath, JSON.stringify(document, null, 2), "utf-8");
      renameSync(tmpPath, outputPath);
    } catch (error) {
      if (existsSync(tmpPath)) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // 清理失败可忽略
        }
      }
      throw error;
    }

    return {
      success: true,
      outputPath,
      count: memories.length,
      containerTag: project.tag,
      scopeHash,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("exportMemories: error", { error: errorMessage });
    return { success: false, error: errorMessage };
  }
}

export async function importMemories(
  embedder: Embedder,
  options: ImportMemoriesOptions
): Promise<ImportMemoriesResult> {
  try {
    await ensureTursoReady();
    await embedder.warmup();

    const inputPath = resolve(options.inputPath);
    if (!existsSync(inputPath)) {
      return { success: false, dryRun: Boolean(options.dryRun), error: `Import file not found: ${inputPath}` };
    }

    if (statSync(inputPath).size > MAX_IMPORT_BYTES) {
      return {
        success: false,
        dryRun: Boolean(options.dryRun),
        error: `Import file exceeds ${MAX_IMPORT_BYTES} byte limit`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(inputPath, "utf-8"));
    } catch (error) {
      return {
        success: false,
        dryRun: Boolean(options.dryRun),
        error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      "schemaVersion" in parsed &&
      typeof (parsed as { schemaVersion: unknown }).schemaVersion === "number" &&
      (parsed as { schemaVersion: number }).schemaVersion > PORTABILITY_SCHEMA_VERSION
    ) {
      return {
        success: false,
        dryRun: Boolean(options.dryRun),
        error: `Unsupported export schemaVersion ${(parsed as { schemaVersion: number }).schemaVersion}. Upgrade dsh-mem to import this file.`,
      };
    }

    const validated = MemoryExportDocumentSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        success: false,
        dryRun: Boolean(options.dryRun),
        error: `Invalid export document: ${validated.error.issues.map((issue) => issue.message).join("; ")}`,
      };
    }

    const document = validated.data;
    const target = getProjectTagInfo(options.currentDirectory);
    const { scope, hash } = extractScopeFromContainerTag(target.tag);

    // 预扫目标项目分片的 ID 冲突
    const targetShards = await tursoShardManager.getAllShards(scope, hash);
    const rejected: Array<{ id: string; reason: string }> = [];
    const skipped: Array<{ id: string; reason: string }> = [];

    for (const memory of document.memories) {
      for (const shard of targetShards) {
        if (!existsSync(shard.dbPath)) continue;
        const db = await tursoConnectionManager.getConnection(shard.dbPath);
        const existing = await tursoVectorSearch.getMemoryById(db, memory.id);
        if (existing) {
          rejected.push({ id: memory.id, reason: "memory id already exists in target project" });
          break;
        }
      }
    }

    if (rejected.length > 0) {
      return {
        success: false,
        dryRun: Boolean(options.dryRun),
        imported: 0,
        rejected,
        containerTag: target.tag,
        error: `Import aborted: ${rejected.length} memory id(s) already exist in the target project`,
      };
    }

    if (options.dryRun) {
      return {
        success: true,
        dryRun: true,
        imported: document.memories.length,
        skipped,
        rejected,
        containerTag: target.tag,
      };
    }

    const releaseLock = acquireTursoOperationLock("memory-import");
    const insertedIds: string[] = [];

    try {
      // 阶段 A：先算全部向量，不写库
      const prepared: Array<{ record: StoredMemory; isPinned: boolean }> = [];
      for (const memory of document.memories) {
        const tags = memory.tags ?? [];
        const vector = await embedder.embed(memory.content, "document");
        const tagsVector =
          tags.length > 0 ? await embedder.embed(formatTagsForEmbedding(tags), "document") : undefined;

        const metadata = {
          ...(memory.metadata ?? {}),
          source: "import",
          importedAt: Date.now(),
          exportSchemaVersion: document.schemaVersion,
          originalContainerTag: document.source.containerTag,
          originalProjectPath: document.source.projectPath,
        };

        prepared.push({
          record: {
            id: memory.id,
            content: memory.content,
            vector,
            tagsVector,
            containerTag: target.tag,
            tags: tags.length > 0 ? tags.join(",") : undefined,
            type: memory.type,
            createdAt: memory.createdAt,
            updatedAt: memory.updatedAt ?? memory.createdAt,
            metadata: JSON.stringify(metadata),
            displayName: target.displayName,
            userName: memory.userName,
            userEmail: memory.userEmail,
            projectPath: target.projectPath,
            projectName: target.projectName,
            gitRepoUrl: target.gitRepoUrl,
          },
          isPinned: Boolean(memory.isPinned),
        });
      }

      // 阶段 B：单事务写入。已持操作锁，绕过 getWriteShard 的迁移检查
      return await tursoShardManager.withScopeWriteLock(scope, hash, async () => {
        let shard = await tursoShardManager.getActiveShard(scope, hash);
        if (!shard) shard = await tursoShardManager.createShard(scope, hash, 0);
        const db = await tursoConnectionManager.getConnection(shard.dbPath);

        await db.transaction("write", async (tx) => {
          for (const item of prepared) {
            await tursoVectorSearch.insertVectorInTransaction(tx, item.record);
            if (item.isPinned) {
              await tx.execute({ sql: `UPDATE memories SET is_pinned = 1 WHERE id = ?`, args: [item.record.id] });
            }
            insertedIds.push(item.record.id);
          }
        });

        await tursoShardManager.setVectorCount(shard.id, await tursoVectorSearch.countAllVectors(db));

        log("Memory import completed", { imported: insertedIds.length, containerTag: target.tag });
        return {
          success: true,
          dryRun: false,
          imported: insertedIds.length,
          skipped,
          rejected,
          containerTag: target.tag,
        };
      });
    } catch (error) {
      // 事务外残留的最佳努力清理
      if (insertedIds.length > 0) {
        try {
          const shards = await tursoShardManager.getAllShards(scope, hash);
          for (const shard of shards) {
            const db = await tursoConnectionManager.getConnection(shard.dbPath);
            for (const id of insertedIds) {
              const existing = await tursoVectorSearch.getMemoryById(db, id);
              if (existing) await tursoVectorSearch.deleteVector(db, id);
            }
            await tursoShardManager.setVectorCount(shard.id, await tursoVectorSearch.countAllVectors(db));
          }
        } catch (cleanupError) {
          log("Memory import cleanup failed", { error: String(cleanupError) });
        }
      }

      return {
        success: false,
        dryRun: false,
        imported: 0,
        error: error instanceof Error ? error.message : String(error),
        containerTag: target.tag,
      };
    } finally {
      releaseLock();
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log("importMemories: error", { error: errorMessage });
    return { success: false, dryRun: Boolean(options.dryRun), error: errorMessage };
  }
}
