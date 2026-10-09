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

// memory 工具：宿主注册的多模式记忆工具
// 契约：defineTool 传 name 与 description 与 parameters 与 output，execute 返回 canonical value
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { getConfig } from "../config.js";
import type { MemorySearchResult } from "../types.js";
import { isFullyPrivate, stripPrivateContent } from "../services/privacy.js";
import { userPromptStore } from "../services/user-prompt-store.js";
import { log } from "../services/logger.js";
import type { MemoryClientLike, TagsLike, UserProfileManagerLike } from "../services/contracts.js";

const MEMORY_MODES = ["add", "search", "profile", "list", "forget", "help", "migrate", "list-shards", "export", "import"] as const;
type MemoryMode = (typeof MEMORY_MODES)[number];

export interface MemoryToolDeps {
  memoryClient: MemoryClientLike & Partial<PortabilityMethods>;
  /** 装配时兜底 tags，执行时应优先用 getActiveTags */
  tags: TagsLike;
  /** 活跃 tags 提供者，项目身份跟随会话工作区 */
  getActiveTags?: (overrideDirectory?: string) => TagsLike;
  profileManager: UserProfileManagerLike;
  /** 装配时兜底工作区目录，可携性模式应优先用 getActiveDirectory */
  directory: string;
  /**
   * 活跃工作区目录提供者，与 getActiveTags 同源。
   * 可携性四模式依赖它，否则会认成装配目录
   */
  getActiveDirectory?: (overrideDirectory?: string) => string;
}

/** 可携性四模式依赖的客户端方法，缺失时给可行动的报错 */
export interface PortabilityMethods {
  listShards(currentDirectory: string): Promise<{
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
  }>;
  migrateProjectPath(options: {
    currentDirectory: string;
    fromPath?: string;
    fromHash?: string;
    dryRun?: boolean;
    allowLinkedSource?: boolean;
  }): Promise<{
    success: boolean;
    dryRun: boolean;
    migratedMemories?: number;
    oldHash?: string;
    newHash?: string;
    error?: string;
  }>;
  exportMemories(options: { currentDirectory: string; outputPath: string }): Promise<{
    success: boolean;
    outputPath?: string;
    count?: number;
    containerTag?: string;
    scopeHash?: string;
    error?: string;
  }>;
  importMemories(options: { currentDirectory: string; inputPath: string; dryRun?: boolean }): Promise<{
    success: boolean;
    dryRun: boolean;
    imported?: number;
    skipped?: Array<{ id: string; reason: string }>;
    rejected?: Array<{ id: string; reason: string }>;
    containerTag?: string;
    error?: string;
  }>;
}

interface MemoryArgs {
  mode?: MemoryMode;
  content?: string;
  query?: string;
  tags?: string;
  type?: string;
  memoryId?: string;
  limit?: number;
  scope?: "project" | "all";
  fromPath?: string;
  fromHash?: string;
  outputPath?: string;
  inputPath?: string;
  dryRun?: boolean;
  allowLinkedSource?: boolean;
}

/** output.schema 要求 additionalProperties 兼容，故带索引签名 */
type JsonValue = import("@deepseek-ai/dsh-util-values").JsonValue;
type MemoryToolValue = {
  [key: string]: JsonValue;
} & {
  success: boolean;
  mode: string;
  message?: string;
  error?: string;
  count?: number;
  results?: { id: string; content: string; similarity: number; createdAt: number }[];
  memories?: { id: string; content: string; createdAt: number }[];
  profile?: { [key: string]: JsonValue };
  shards?: JsonValue[];
  dryRun?: boolean;
  imported?: number;
  migratedMemories?: number;
  outputPath?: string;
};

function fail(mode: string, error?: string): MemoryToolValue {
  return error === undefined
    ? { success: false, mode }
    : { success: false, mode, error };
}

/** 客户端返回值转 schema 合规输出，剔除 undefined */
function fromResult(mode: string, result: Record<string, unknown>): MemoryToolValue {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      out[key] = value;
      continue;
    }
    try {
      out[key] = JSON.parse(JSON.stringify(value)) as JsonValue;
    } catch {
      // 不可序列化字段丢弃
    }
  }
  const success = out.success === true;
  delete out.success;
  return success ? { success: true, mode, ...out } : { success: false, mode, ...out };
}

function toolText(value: MemoryToolValue): { type: "text"; text: string } {
  return { type: "text", text: JSON.stringify(value, null, 2) };
}

export function createMemoryTool(deps: MemoryToolDeps) {
  return defineTool({
    name: "memory",
    description:
      "Manage and query persistent project memory. Use 'search' with technical keywords/tags, 'add' to store knowledge, 'profile' for user preferences. Use migrate/list-shards/export/import when a project directory moves. Search/list scope: project or all.",
    parameters: {
      mode: {
        type: "string",
        enum: [...MEMORY_MODES],
        description: "Operation: add | search | profile | list | forget | help | migrate | list-shards | export | import",
      },
      content: { type: "string", description: "Memory content to store (mode=add) or explicit preference (mode=profile with content)" },
      query: { type: "string", description: "Search query keywords (mode=search)" },
      tags: { type: "string", description: "Comma-separated tags (mode=add)" },
      type: { type: "string", description: "Memory type label (mode=add)" },
      memoryId: { type: "string", description: "Memory id to remove (mode=forget)" },
      limit: { type: "integer", description: "Max entries for list (default 20)" },
      scope: { type: "string", enum: ["project", "all"], description: "Search/list scope (default from config)" },
      fromPath: { type: "string", description: "Previous project directory (mode=migrate; fromHash alternative)" },
      fromHash: { type: "string", description: "Previous project scope hash (mode=migrate; fromPath alternative)" },
      outputPath: { type: "string", description: "Output JSON file path (mode=export)" },
      inputPath: { type: "string", description: "Input JSON file path (mode=import)" },
      dryRun: { type: "boolean", description: "Preview without writing (mode=migrate/import)" },
      allowLinkedSource: { type: "boolean", description: "Allow migrating from a symlinked source path (mode=migrate)" },
    },
    timeoutMs: 120000,
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          success: { type: "boolean", required: true },
          mode: { type: "string", required: true },
          message: { type: "string" },
          error: { type: "string" },
          count: { type: "integer" },
          results: { type: "array", items: { type: "object", additionalProperties: true } },
          memories: { type: "array", items: { type: "object", additionalProperties: true } },
          profile: { type: "object", additionalProperties: true },
        },
      },
      render: (_args, value) => [toolText(value as MemoryToolValue)],
    },
    execute: async (args: MemoryArgs, exec: ToolRunContext): Promise<MemoryToolValue> => {
      const mode: MemoryMode = args.mode ?? "help";
      const cfg = getConfig();
      // 项目身份跟随会话工作区，优先读 exec 携带的会话 cwd
      // 规则与 dsh-tool-fs 一致，其次宿主提供的 getActiveTags，最后兜底装配 tags
      const execSessionCwd = (exec as { agent?: { session?: { header?: { cwd?: string } } } }).agent?.session?.header?.cwd;
      const tags = execSessionCwd
        ? (deps.getActiveTags?.(execSessionCwd) ?? deps.tags)
        : (deps.getActiveTags?.() ?? deps.tags);
      // 可携性模式用同一个活跃目录，否则会认成装配目录
      const activeDirectory = execSessionCwd
        ? (deps.getActiveDirectory?.(execSessionCwd) ?? execSessionCwd)
        : (deps.getActiveDirectory?.() ?? deps.directory);

      // help 不依赖初始化，add 与 search 依赖嵌入，其余依赖存储
      // 未初始化的失败由 warmup 与 ensureStorageReady 自然抛出，不重复门控
      const needsEmbedding = mode === "add" || mode === "search";
      if (needsEmbedding) {
        const embeddingError = deps.memoryClient.getEmbeddingInitError();
        if (embeddingError) return { success: false, mode, error: embeddingError };
      }

      // 可携性模式需要 core 客户端提供方法，缺失时给可行动的报错而非 TypeError
      const portability =
        mode === "migrate" || mode === "list-shards" || mode === "export" || mode === "import"
          ? (deps.memoryClient as Partial<PortabilityMethods>)
          : undefined;
      if (portability) {
        const required: Array<keyof PortabilityMethods> =
          mode === "migrate"
            ? ["migrateProjectPath"]
            : mode === "list-shards"
              ? ["listShards"]
              : mode === "export"
                ? ["exportMemories"]
                : ["importMemories"];
        const missing = required.filter((name) => typeof portability[name] !== "function");
        if (missing.length > 0) {
          return {
            success: false,
            mode,
            error: `memory client does not implement ${missing.join(", ")} yet (core module pending)`,
          };
        }
      }

      try {
        if (needsEmbedding) {
          await deps.memoryClient.warmup();
        } else if (mode !== "help") {
          await deps.memoryClient.ensureStorageReady();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, mode, error: `memory system failed to initialize: ${message}` };
      }

      if (exec.signal.aborted) return { success: false, mode, error: "aborted" };

      try {
        switch (mode) {
          case "help":
            return {
              success: true,
              mode,
              message:
                "memory: add(content,tags?,type?) | search(query,scope?) | list(limit?,scope?) | forget(memoryId) | profile(content? to write a preference, omit to read) | list-shards() | migrate(fromPath|fromHash,dryRun?,allowLinkedSource?) | export(outputPath) | import(inputPath,dryRun?)",
            };

          case "add": {
            if (!args.content) return { success: false, mode, error: "content required" };
            const sanitized = stripPrivateContent(args.content);
            if (isFullyPrivate(args.content)) return { success: false, mode, error: "private content blocked" };
            const parsedTags = args.tags
              ? args.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
              : undefined;
            const tagInfo = tags.project;
            const projectMeta = tagInfo as typeof tagInfo & { userName?: string; userEmail?: string };
            const result = await deps.memoryClient.addMemory(sanitized, tagInfo.tag, {
              source: "manual",
              type: args.type,
              tags: parsedTags,
              displayName: tagInfo.displayName,
              userName: projectMeta.userName,
              userEmail: projectMeta.userEmail,
              projectPath: tagInfo.projectPath,
              projectName: tagInfo.projectName,
              gitRepoUrl: tagInfo.gitRepoUrl,
            });
            if (!result.success) return fail(mode, result.error);
            return { success: true, mode, message: "memory added", count: 1 };
          }

          case "search": {
            if (!args.query) return { success: false, mode, error: "query required" };
            const searchResult = await deps.memoryClient.searchMemories(
              args.query,
              tags.project.tag,
              args.scope ?? cfg.memoryDefaultScope,
            );
            if (!searchResult.success) return fail(mode, searchResult.error);
            const results: MemorySearchResult[] = searchResult.results;
            return {
              success: true,
              mode,
              count: results.length,
              results: results.slice(0, args.limit ?? 10).map((r) => ({
                id: r.id,
                content: r.memory,
                similarity: Math.round(r.similarity * 100),
                createdAt: r.createdAt,
              })),
            };
          }

          case "list": {
            const listResult = await deps.memoryClient.listMemories(
              tags.project.tag,
              args.limit ?? cfg.maxMemories,
              args.scope ?? cfg.memoryDefaultScope,
            );
            if (!listResult.success) return fail(mode, listResult.error);
            return {
              success: true,
              mode,
              count: listResult.memories.length,
              memories: listResult.memories.map((m) => ({ id: m.id, content: m.content, createdAt: m.createdAt })),
            };
          }

          case "forget": {
            if (!args.memoryId) return { success: false, mode, error: "memoryId required" };
            const del = await deps.memoryClient.deleteMemory(args.memoryId);
            if (!del.success) return fail(mode, del.error);
            return { success: true, mode, message: "memory removed" };
          }

          case "profile": {
            const userId = tags.user.userEmail ?? "unknown";
            if (args.content !== undefined) {
              const trimmed = args.content.trim();
              if (!trimmed) return { success: false, mode, error: "content must not be blank" };
              if (isFullyPrivate(trimmed)) return { success: false, mode, error: "private content blocked" };
              const { mergeExplicitPreference } = await import("../services/profile-learning.js");
              const outcome = await mergeExplicitPreference(
                { tags, llm: { complete: async () => "" } as never, profileManager: deps.profileManager },
                userId,
                trimmed,
              );
              return { success: true, mode, message: outcome === "merged" ? "preference saved to profile" : "profile created with preference" };
            }
            const profile = await deps.profileManager.getActiveProfile(userId);
            if (!profile) return { success: true, mode, message: "no profile yet" };
            let data: { [key: string]: import("@deepseek-ai/dsh-util-values").JsonValue } | undefined;
            try {
              data = JSON.parse(profile.profileData);
            } catch {
              data = undefined;
            }
            if (!data) return { success: true, mode, message: "profile data unreadable" };
            return { success: true, mode, profile: data };
          }

          case "list-shards": {
            const listShardsResult = await portability!.listShards!(activeDirectory);
            return fromResult(mode, listShardsResult as unknown as Record<string, unknown>);
          }

          case "migrate": {
            if (!args.fromPath && !args.fromHash) {
              return {
                success: false,
                mode,
                error: "fromPath or fromHash required. Run memory list-shards to discover orphaned shards.",
              };
            }
            const migrateResult = await portability!.migrateProjectPath!({
              currentDirectory: activeDirectory,
              fromPath: args.fromPath,
              fromHash: args.fromHash,
              dryRun: args.dryRun,
              allowLinkedSource: args.allowLinkedSource,
            });
            return fromResult(mode, migrateResult as unknown as Record<string, unknown>);
          }

          case "export": {
            if (!args.outputPath) return { success: false, mode, error: "outputPath required" };
            const exportResult = await portability!.exportMemories!({
              currentDirectory: activeDirectory,
              outputPath: args.outputPath,
            });
            return fromResult(mode, exportResult as unknown as Record<string, unknown>);
          }

          case "import": {
            if (!args.inputPath) return { success: false, mode, error: "inputPath required" };
            const importResult = await portability!.importMemories!({
              currentDirectory: activeDirectory,
              inputPath: args.inputPath,
              dryRun: args.dryRun,
            });
            return fromResult(mode, importResult as unknown as Record<string, unknown>);
          }

          default:
            return { success: false, mode, error: `unknown mode: ${String(mode)}` };
        }
      } catch (error) {
        log("memory tool error", { mode, error: String(error) });
        return { success: false, mode, error: String(error) };
      }
    },
  });
}

// 测试辅助：清理 user-prompt store
export async function closeUserPromptStoreForTests(): Promise<void> {
  await userPromptStore.close();
}
