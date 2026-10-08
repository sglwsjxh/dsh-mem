// memory 工具：dsh 宿主注册的多模式记忆工具
// 契约：defineTool(name/description/parameters/output)，execute(args, exec) 返回 canonical value
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
  tags: TagsLike;
  profileManager: UserProfileManagerLike;
  /** 当前工作区目录（project tag 来源） */
  directory: string;
}

/** 可携性四模式依赖的客户端方法（core 的 LocalMemoryClient 实现；结构化可选，缺失时运行时报错） */
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

/** 规范输出值：工具 output.schema 约束（additionalProperties: true 要求索引签名兼容） */
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

/** 构造失败输出：undefined 字段直接剔除，保证值符合 output schema */
function fail(mode: string, error?: string): MemoryToolValue {
  return error === undefined
    ? { success: false, mode }
    : { success: false, mode, error };
}

/** 把客户端方法返回的 result 转成 schema 合规输出：剔除 undefined，值规整为 JsonValue */
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

      // help 不依赖初始化；add/search 依赖嵌入；其余依赖存储。
      // 未初始化的失败由 warmup/ensureStorageReady 自然抛出，不在此重复门控。
      const needsEmbedding = mode === "add" || mode === "search";
      if (needsEmbedding) {
        const embeddingError = deps.memoryClient.getEmbeddingInitError();
        if (embeddingError) return { success: false, mode, error: embeddingError };
      }

      // 可携性模式需要 core 客户端提供对应方法；缺失时给可行动的报错而不是 TypeError
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

      // dispose 后不再执行新调用
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
            const tagInfo = deps.tags.project;
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
              deps.tags.project.tag,
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
              deps.tags.project.tag,
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
            const userId = deps.tags.user.userEmail ?? "unknown";
            if (args.content !== undefined) {
              const trimmed = args.content.trim();
              if (!trimmed) return { success: false, mode, error: "content must not be blank" };
              if (isFullyPrivate(trimmed)) return { success: false, mode, error: "private content blocked" };
              const { mergeExplicitPreference } = await import("../services/profile-learning.js");
              const outcome = await mergeExplicitPreference(
                { tags: deps.tags, llm: { complete: async () => "" } as never, profileManager: deps.profileManager },
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
            const listShardsResult = await portability!.listShards!(deps.directory);
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
              currentDirectory: deps.directory,
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
              currentDirectory: deps.directory,
              outputPath: args.outputPath,
            });
            return fromResult(mode, exportResult as unknown as Record<string, unknown>);
          }

          case "import": {
            if (!args.inputPath) return { success: false, mode, error: "inputPath required" };
            const importResult = await portability!.importMemories!({
              currentDirectory: deps.directory,
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
