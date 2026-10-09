// host 集成层单测：注入过滤 / 上下文格式 / 捕获上下文组装 / prompt store / memory 工具
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DshMemConfig } from "../src/types.js";

// initConfig 不再接受参数且只读 ~/.dsh 固定路径；测试用 vi.hoisted 状态 + vi.mock 注入配置单例
const { mockGetConfig, setTestCfg } = vi.hoisted(() => {
  const state = { cfg: null as DshMemConfig | null };
  return {
    setTestCfg: (cfg: DshMemConfig | null) => {
      state.cfg = cfg;
    },
    mockGetConfig: () => {
      if (!state.cfg) throw new Error("dsh-mem config not initialized; initConfig() failed or was not called");
      return state.cfg;
    },
  };
});

vi.mock("../src/config.js", () => ({
  CONFIG_PATH: "unused",
  initConfig: () => mockGetConfig(),
  getConfig: mockGetConfig,
  isConfigured: () => true,
  resetConfig: () => setTestCfg(null),
}));

// mock 就位后再加载被测模块
import { UserPromptStore } from "../src/services/user-prompt-store.js";
import { buildMarkdownContext, buildBoundedSummaryPrompt, getAutoCaptureMarkdownBudget } from "../src/services/auto-capture.js";
import { formatContextForPrompt } from "../src/services/context-format.js";
import { extractAuthoredUserText, SessionTurnCollector } from "../src/plugin.js";
import { stripPrivateContent, isFullyPrivate } from "../src/services/privacy.js";
import { truncateToMaxBytes, utf8ByteLength } from "../src/services/context-limit.js";
import type { UserMessage } from "@deepseek-ai/dsh-session";
import { createMessage, MessageId } from "@deepseek-ai/dsh-llm";
import type { MemoryClientLike, TagsLike, UserProfileManagerLike } from "../src/services/contracts.js";

function makeCfg(dataPath: string): DshMemConfig {
  return {
    dataPath,
    embedding: { model: "test-model", baseUrl: "http://127.0.0.1:1/v1", apiKey: "" },
    llm: { platform: "openai", baseUrl: "http://127.0.0.1:1/v1", model: "test-llm", apiKey: "", timeoutMs: 1000 },
    autoCaptureEnabled: true,
    autoCaptureMaxRetries: 3,
    autoCaptureMaxContext: 131072,
    similarityThreshold: 0.5,
    maxMemories: 10,
    memoryDefaultScope: "project",
    deduplicationEnabled: true,
    deduplicationSimilarityThreshold: 0.85,
    autoCleanupEnabled: true,
    autoCleanupRetentionDays: 30,
    maxVectorsPerShard: 50000,
    injectEnabled: true,
    injectMaxMemories: 3,
    injectExcludeCurrentSession: true,
    injectProfile: true,
    userProfileEnabled: true,
    userProfileAnalysisInterval: 10,
    userProfileMaxContext: 32768,
    userProfileStaleDays: 2,
  };
}

function userMessage(content: string, kind: "user" | "system-prompt" = "user"): UserMessage {
  const base = {
    content: [{ type: "text" as const, text: content }],
    source: kind === "user" ? { kind: "user" as const } : { kind: "system-prompt" as const },
  };
  return createMessage(base as never) as UserMessage;
}

describe("injection filter via extractAuthoredUserText", () => {
  it("keeps ordinary user text", () => {
    const text = extractAuthoredUserText(userMessage("帮我修这个 bug"));
    expect(text).toBe("帮我修这个 bug");
  });

  it("drops system-reminder wrapped content", () => {
    const text = extractAuthoredUserText(userMessage("<system-reminder>auto context</system-reminder>"));
    expect(text).toBeNull();
  });

  it("drops internal summary prompts", () => {
    const text = extractAuthoredUserText(userMessage('# User Profile Analysis\ndata'));
    expect(text).toBeNull();
  });

  it("drops non-user source messages", () => {
    const msg = userMessage("hello", "system-prompt");
    const blocks = msg.content.filter((b) => (b as { type?: string }).type === "text");
    expect(blocks.length).toBe(1);
    expect(extractAuthoredUserText(msg)).toBe("hello");
  });
});

describe("session turn collector", () => {
  it("collects user prompts, assistant text, and tool calls per session", () => {
    const collector = new SessionTurnCollector();
    collector.beginTurn("s1", "first prompt");
    collector.recordAssistantText("s1", "assistant answer");
    collector.recordToolCall("s1", "read", { path: "a.ts" });
    const ctx = collector.take("s1");
    expect(ctx.userPrompts).toEqual(["first prompt"]);
    expect(ctx.assistantResponses).toEqual(["assistant answer"]);
    expect(ctx.toolCalls).toEqual([{ name: "read", input: "path: \"a.ts\"" }]);
    expect(collector.take("s1").userPrompts).toEqual([]);
  });
});

describe("privacy filter", () => {
  it("redacts private regions", () => {
    expect(stripPrivateContent("before<private>secret</private>after")).toBe("before[REDACTED]after");
    expect(stripPrivateContent("<private>unclosed")).toBe("[REDACTED]");
    expect(stripPrivateContent("<private>a<private>b</private>c</private>")).toBe("[REDACTED]");
    expect(isFullyPrivate("<private>x</private>")).toBe(true);
    expect(isFullyPrivate("ok content")).toBe(false);
  });
});

describe("context truncation", () => {
  it("respects byte budgets", () => {
    const text = "x".repeat(1000);
    const truncated = truncateToMaxBytes(text, 100);
    expect(utf8ByteLength(truncated)).toBeLessThanOrEqual(100);
    const budget = getAutoCaptureMarkdownBudget(1000);
    expect(budget).toBeGreaterThan(0);
  });
});

describe("markdown context builder", () => {
  it("includes all sections and stays within budget", () => {
    const out = buildMarkdownContext(
      "user asked to fix a bug",
      ["I fixed the bug in auth.ts"],
      [{ name: "edit", input: "file: auth.ts" }],
      "previous memory",
      8192,
    );
    expect(out).toContain("## User Request");
    expect(out).toContain("## AI Response");
    expect(out).toContain("## Tools Used");
    expect(out).toContain("## Previous Memory Context");
    expect(utf8ByteLength(out)).toBeLessThanOrEqual(8192);
  });

  it("omits AI section when there are no responses", () => {
    const out = buildMarkdownContext("prompt only", [], [], null, 4096);
    expect(out).toContain("## User Request");
    expect(out).not.toContain("## AI Response");
  });

  it("bounded summary prompt stays in budget", () => {
    const prompt = buildBoundedSummaryPrompt("long context ".repeat(5000), "system", "{}", 16384);
    expect(utf8ByteLength(prompt)).toBeLessThanOrEqual(16384);
  });
});

describe("context format", () => {
  beforeEach(() => {
    setTestCfg(makeCfg(join(tmpdir(), "dsh-mem-cfgfmt-")));
  });

  afterEach(() => {
    setTestCfg(null);
  });

  it("formats memory context with profile", async () => {
    const out = await formatContextForPrompt(
      "user@example.com",
      { results: [{ similarity: 0.987, memory: "fixed auth bug" }] },
      async () => ({
        preferences: [{ category: "code style", description: "prefers TypeScript", confidence: 0.8, frequency: 3, evidence: [], lastSeen: Date.now() }],
        patterns: [],
        workflows: [],
      }),
    );
    expect(out).toContain("<memory_context>");
    expect(out).toContain("<user_profile>");
    expect(out).toContain("prefers TypeScript");
    expect(out).toContain('<memory relevance="99%">');
    expect(out).toContain("fixed auth bug");
  });

  it("returns empty without entries", async () => {
    const out = await formatContextForPrompt(null, { results: [] });
    expect(out).toBe("");
  });
});

describe("user prompt store", () => {
  let dir: string;
  let store: UserPromptStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh-mem-test-"));
    setTestCfg(makeCfg(dir));
    store = new UserPromptStore(dir);
  });

  afterEach(async () => {
    await store.close();
    setTestCfg(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("saves idempotently per session+message", async () => {
    const id1 = await store.savePrompt("s1", "m1", "/proj", "hello");
    const id2 = await store.savePrompt("s1", "m1", "/proj", "hello");
    expect(id1).toBe(id2);
  });

  it("claim / fail / release lifecycle", async () => {
    await store.savePrompt("s1", "m1", "/proj", "hello");
    const prompts = await store.getUncapturedPromptsForSession("s1");
    expect(prompts).toHaveLength(1);
    expect(await store.claimPrompt(prompts[0]!.id)).toBe(true);
    expect(await store.claimPrompt(prompts[0]!.id)).toBe(false);
    await store.releaseClaim(prompts[0]!.id);
    expect(await store.claimPrompt(prompts[0]!.id)).toBe(true);
    await store.recordFailedAttempt(prompts[0]!.id);
    await store.releaseClaim(prompts[0]!.id);
    const after = await store.getUncapturedPromptsForSession("s1");
    expect(after).toHaveLength(1);
    expect(after[0]!.captureAttempts).toBe(1);
    await store.markAsCaptured(prompts[0]!.id);
    expect(await store.getUncapturedPromptsForSession("s1")).toHaveLength(0);
  });

  it("retries exhausted prompts drop out", async () => {
    await store.savePrompt("s2", "m1", "/proj", "hello");
    for (let i = 0; i < 3; i++) {
      const prompts = await store.getUncapturedPromptsForSession("s2");
      if (prompts.length === 0) break;
      await store.claimPrompt(prompts[0]!.id);
      await store.recordFailedAttempt(prompts[0]!.id);
      await store.releaseClaim(prompts[0]!.id);
    }
    expect(await store.getUncapturedPromptsForSession("s2")).toHaveLength(0);
  });

  it("user learning queue", async () => {
    await store.savePrompt("s3", "m1", "/proj", "a");
    await store.savePrompt("s3", "m2", "/proj", "b");
    expect(await store.countUnanalyzedForUserLearning()).toBe(2);
    const prompts = await store.getPromptsForUserLearning(2);
    expect(prompts).toHaveLength(2);
    await store.markMultipleAsUserLearningCaptured(prompts.map((p) => p.id));
    expect(await store.countUnanalyzedForUserLearning()).toBe(0);
  });

  it("delete old prompts", async () => {
    await store.savePrompt("s4", "m1", "/proj", "old");
    const deleted = await store.deleteOldPrompts(Date.now() + 1000);
    expect(deleted).toBe(1);
  });
});

describe("memory tool", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh-mem-tool-"));
    setTestCfg(makeCfg(dir));
  });

  afterEach(() => {
    setTestCfg(null);
    rmSync(dir, { recursive: true, force: true });
  });

  function makeDeps() {
    const added: { content: string; containerTag: string; metadata?: Record<string, unknown> }[] = [];
    const memoryClient: MemoryClientLike = {
      warmup: async () => {},
      isReady: () => true,
      getEmbeddingInitError: () => null,
      ensureStorageReady: async () => {},
      addMemory: async (content, containerTag, metadata) => {
        added.push({ content, containerTag, metadata });
        return { success: true, id: `mem_${added.length}` };
      },
      searchMemories: async () => ({
        success: true,
        results: [{ id: "mem_1", memory: "found it", similarity: 0.92, createdAt: Date.now(), tags: [], containerTag: "tag" }],
      }),
      listMemories: async () => ({
        success: true,
        memories: [{ id: "mem_1", content: "a memory", createdAt: Date.now(), updatedAt: Date.now(), containerTag: "tag", tags: [] }],
      }),
      deleteMemory: async (memoryId) => (memoryId === "mem_1" ? { success: true } : { success: false, error: "Memory not found" }),
      searchMemoriesBySessionID: async () => ({ success: true, results: [] }),
      close: async () => {},
    };
    const tags: TagsLike = {
      user: { tag: "dshmem_user_x", displayName: "tester", userName: "tester", userEmail: "t@e.st" },
      project: { tag: "dshmem_project_x", displayName: "proj", projectPath: "/proj", projectName: "proj" },
    };
    const profiles = new Map<string, string>();
    const profileManager: UserProfileManagerLike = {
      getActiveProfile: async (userId) => {
        const data = profiles.get(userId);
        return data
          ? {
              id: `p_${userId}`,
              userId,
              profileData: data,
              version: 1,
              lastAnalyzedAt: Date.now(),
              createdAt: Date.now(),
              updatedAt: Date.now(),
            }
          : null;
      },
      createProfile: async (userId, _d, _u, _e, data) => {
        profiles.set(userId, JSON.stringify(data));
      },
      updateProfile: async (profileId, data) => {
        const userId = profileId.replace("p_", "");
        profiles.set(userId, JSON.stringify(data));
        return true;
      },
      mergeProfileData: async (existing, incoming) => ({
        preferences: [...existing.preferences, ...(incoming.preferences ?? [])],
        patterns: [...existing.patterns, ...(incoming.patterns ?? [])],
        workflows: [...existing.workflows, ...(incoming.workflows ?? [])],
      }),
    };
    return { memoryClient, tags, profileManager, added, profiles };
  }

  it("exercises add/search/list/forget/profile/help through the tool contract", async () => {
    const { createMemoryTool } = await import("../src/tools/memory.js");
    const deps = makeDeps();
    const tool = createMemoryTool({ ...deps, directory: "/proj" }) as {
      execute: (args: Record<string, unknown>, exec: unknown) => Promise<{
        success: boolean;
        message?: string;
        error?: string;
        results?: { content: string }[];
        memories?: { content: string }[];
        profile?: unknown;
      }>;
    };

    // help 模式：无需 warmup
    const help = await tool.execute({ mode: "help" }, makeExec());
    expect(help.success).toBe(true);
    expect(help.message).toContain("add");

    // add
    const added = await tool.execute({ mode: "add", content: "fix auth bug", tags: "auth, bug" }, makeExec());
    expect(added.success).toBe(true);
    expect(deps.added).toHaveLength(1);
    expect(deps.added[0]!.metadata?.tags).toEqual(["auth", "bug"]);

    // search
    const search = await tool.execute({ mode: "search", query: "auth" }, makeExec());
    expect(search.success).toBe(true);
    expect(search.results?.[0]!.content).toBe("found it");

    // list
    const list = await tool.execute({ mode: "list", limit: 5 }, makeExec());
    expect(list.success).toBe(true);
    expect(list.memories?.[0]!.content).toBe("a memory");

    // forget
    const forgotten = await tool.execute({ mode: "forget", memoryId: "mem_1" }, makeExec());
    expect(forgotten.success).toBe(true);
    const missing = await tool.execute({ mode: "forget", memoryId: "nope" }, makeExec());
    expect(missing.success).toBe(false);
    expect(missing.error).toBe("Memory not found");

    // profile 写入 + 读取
    const wrote = await tool.execute({ mode: "profile", content: "likes concise answers" }, makeExec());
    expect(wrote.success).toBe(true);
    const read = await tool.execute({ mode: "profile" }, makeExec());
    expect(read.success).toBe(true);
    const profileData = read.profile as { preferences: { description: string }[] };
    expect(profileData.preferences.some((p) => p.description === "likes concise answers")).toBe(true);
  });

  it("blocks private content on add", async () => {
    const { createMemoryTool } = await import("../src/tools/memory.js");
    const deps = makeDeps();
    const tool = createMemoryTool({ ...deps, directory: "/proj" }) as {
      execute: (args: Record<string, unknown>, exec: unknown) => Promise<{ success: boolean; error?: string }>;
    };
    const blocked = await tool.execute({ mode: "add", content: "<private>secret</private>" }, makeExec());
    expect(blocked.success).toBe(false);
    expect(blocked.error).toBe("private content blocked");
    expect(deps.added).toHaveLength(0);
  });

  it("dispatches portability modes (list-shards/migrate/export/import) with dryRun passthrough", async () => {
    const { createMemoryTool } = await import("../src/tools/memory.js");
    const deps = makeDeps();
    const calls: string[] = [];
    const client = {
      ...deps.memoryClient,
      listShards: async (currentDirectory: string) => {
        calls.push(`listShards:${currentDirectory}`);
        return {
          success: true,
          storagePath: "/data",
          currentProject: { tag: "dshmem_project_x", scopeHash: "abc123", projectPath: "/proj" },
          shards: [
            { id: 1, scope: "project", scopeHash: "abc123", shardIndex: 0, dbPath: "/data/shard-1.db", vectorCount: 7, isActive: true, fileExists: true },
          ],
        };
      },
      migrateProjectPath: async (options: Record<string, unknown>) => {
        calls.push(`migrate:${JSON.stringify(options)}`);
        return { success: true, dryRun: Boolean(options.dryRun), oldHash: "old1", newHash: "abc123", migratedMemories: 3 };
      },
      exportMemories: async (options: { outputPath?: string }) => {
        calls.push(`export:${JSON.stringify(options)}`);
        return { success: true, outputPath: options.outputPath, count: 5, containerTag: "dshmem_project_x", scopeHash: "abc123" };
      },
      importMemories: async (options: Record<string, unknown>) => {
        calls.push(`import:${JSON.stringify(options)}`);
        return {
          success: true,
          dryRun: Boolean(options.dryRun),
          imported: 5,
          skipped: [],
          rejected: [{ id: "dup", reason: "memory id already exists in target project" }],
          containerTag: "dshmem_project_x",
        };
      },
    };
    const tool = createMemoryTool({ ...deps, memoryClient: client, directory: "/proj" }) as {
      execute: (args: Record<string, unknown>, exec: unknown) => Promise<Record<string, unknown>>;
    };

    const shards = await tool.execute({ mode: "list-shards" }, makeExec());
    expect(shards.success).toBe(true);
    expect(calls).toContain("listShards:/proj");
    expect(Array.isArray(shards.shards)).toBe(true);

    const migrate = await tool.execute({ mode: "migrate", fromPath: "/old-location", dryRun: true }, makeExec());
    expect(migrate.success).toBe(true);
    expect(migrate.dryRun).toBe(true);
    expect(migrate.migratedMemories).toBe(3);
    expect(migrate.oldHash).toBe("old1");

    const migrateNoArgs = await tool.execute({ mode: "migrate" }, makeExec());
    expect(migrateNoArgs.success).toBe(false);
    expect(migrateNoArgs.error).toContain("fromPath or fromHash required");

    const exported = await tool.execute({ mode: "export", outputPath: "/tmp/out.json" }, makeExec());
    expect(exported.success).toBe(true);
    expect(exported.count).toBe(5);
    expect(exported.outputPath).toBe("/tmp/out.json");

    const exportNoPath = await tool.execute({ mode: "export" }, makeExec());
    expect(exportNoPath.success).toBe(false);
    expect(exportNoPath.error).toBe("outputPath required");

    const imported = await tool.execute({ mode: "import", inputPath: "/tmp/in.json", dryRun: true }, makeExec());
    expect(imported.success).toBe(true);
    expect(imported.dryRun).toBe(true);
    expect(imported.imported).toBe(5);
    expect(Array.isArray(imported.rejected)).toBe(true);

    const importNoPath = await tool.execute({ mode: "import" }, makeExec());
    expect(importNoPath.success).toBe(false);
    expect(importNoPath.error).toBe("inputPath required");

    // dryRun 透传到客户端调用
    const migrateCall = calls.find((c) => c.startsWith("migrate:"));
    expect(migrateCall).toContain('"dryRun":true');
  });

  it("degrades gracefully when the client lacks portability methods", async () => {
    const { createMemoryTool } = await import("../src/tools/memory.js");
    const deps = makeDeps();
    const tool = createMemoryTool({ ...deps, directory: "/proj" }) as {
      execute: (args: Record<string, unknown>, exec: unknown) => Promise<{ success: boolean; error?: string }>;
    };
    const shards = await tool.execute({ mode: "list-shards" }, makeExec());
    expect(shards.success).toBe(false);
    expect(shards.error).toContain("listShards");
    expect(shards.error).toContain("core module pending");

    const exported = await tool.execute({ mode: "export", outputPath: "/tmp/x.json" }, makeExec());
    expect(exported.success).toBe(false);
    expect(exported.error).toContain("exportMemories");
  });

  it("help text documents all ten modes", async () => {
    const { createMemoryTool } = await import("../src/tools/memory.js");
    const deps = makeDeps();
    const tool = createMemoryTool({ ...deps, directory: "/proj" }) as {
      execute: (args: Record<string, unknown>, exec: unknown) => Promise<{ success: boolean; message?: string }>;
    };
    const help = await tool.execute({ mode: "help" }, makeExec());
    expect(help.success).toBe(true);
    for (const mode of ["add", "search", "list", "forget", "profile", "list-shards", "migrate", "export", "import"]) {
      expect(help.message).toContain(mode);
    }
  });
});

function makeExec() {
  const controller = new AbortController();
  return {
    callId: MessageId("call-1") as never,
    rootCallId: MessageId("call-1") as never,
    token: Symbol("token") as never,
    name: "memory",
    arguments: {},
    signal: controller.signal,
    deferContext: () => {},
    concludeTurn: () => {},
  } as never as Parameters<ReturnType<typeof import("../src/tools/memory.js").createMemoryTool>["execute"]>[1];
}
