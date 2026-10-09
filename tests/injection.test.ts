// 记忆注入回归测试：验证 systemPrompt.context 在默认配置下确实产出记忆内容
// 背景：曾因 refreshMemoryContext 里 injectExcludeCurrentSession 分支直接 return，
// 导致 cachedContext 永远为空、注入功能完全失效（README 宣称可用但实际不可用）。
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Context } from "@deepseek-ai/cordis";
import { apply, installPluginDeps } from "../src/plugin.js";
import type { MemoryClientLike, TagsLike, UserProfileManagerLike } from "../src/services/contracts.js";
import type { DshMemConfig, MemoryRecord } from "../src/types.js";

// initConfig 只读 ~/.dsh 固定路径；测试用 vi.hoisted 状态注入内存配置单例
const { setTestCfg, mockGetConfig } = vi.hoisted(() => {
  const state: { cfg: DshMemConfig | null } = { cfg: null };
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

interface CapturedContext {
  name: string;
  order: number;
  text: (assembleCtx?: { signal?: AbortSignal }) => string;
}

/** 构造最小宿主 ctx：捕获注册项，供断言 */
function makeFakeCtx(): { ctx: Context; contexts: CapturedContext[]; events: string[] } {
  const contexts: CapturedContext[] = [];
  const events: string[] = [];
  const ctx = {
    tools: { register: () => () => {} },
    on: (event: string) => {
      events.push(event);
      return () => {};
    },
    systemPrompt: {
      context: (c: CapturedContext) => {
        contexts.push(c);
        return () => {};
      },
    },
    effect: () => () => {},
  } as unknown as Context;
  return { ctx, contexts, events };
}

function makeTags(): TagsLike {
  return {
    user: { tag: "dshmem_user_x", displayName: "tester", userName: "tester", userEmail: "t@e.st" },
    project: { tag: "dshmem_project_x", displayName: "proj", projectPath: "/proj", projectName: "proj" },
  };
}

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem_1",
    content: "项目使用 pnpm workspaces",
    containerTag: "dshmem_project_x",
    tags: ["build"],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("记忆注入（systemPrompt.context）", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh-mem-inject-"));
    setTestCfg({
      dataPath: join(dir, "data"),
      embedding: { model: "test-embedding", baseUrl: "http://127.0.0.1:1/v1", apiKey: "" },
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
    });
  });

  afterEach(() => {
    setTestCfg(null);
    rmSync(dir, { recursive: true, force: true });
  });

  /** 装配插件并返回捕获到的注入回调 */
  function setup(listMemories: MemoryClientLike["listMemories"]): CapturedContext {
    const memoryClient = {
      warmup: async () => {},
      isReady: () => true,
      getEmbeddingInitError: () => null,
      ensureStorageReady: async () => {},
      addMemory: async () => ({ success: true, id: "mem_new" }),
      searchMemories: async () => ({ success: true, results: [] }),
      listMemories,
      deleteMemory: async () => ({ success: true }),
      searchMemoriesBySessionID: async () => ({ success: true, results: [] }),
      close: async () => {},
    } as MemoryClientLike;
    const profileManager = {
      getActiveProfile: async () => null,
      createProfile: async () => {},
      updateProfile: async () => true,
      mergeProfileData: async (existing) => existing,
    } as UserProfileManagerLike;

    installPluginDeps({ memoryClient, tags: makeTags(), llm: { complete: async () => "{}" }, profileManager });
    const { ctx, contexts } = makeFakeCtx();
    apply(ctx, { workspaceRoot: dir });
    expect(contexts).toHaveLength(1);
    return contexts[0]!;
  }

  it("默认配置下注入回调被注册", () => {
    const captured = setup(async () => ({ success: true, memories: [makeMemory()] }));
    expect(captured.name).toBe("dsh-mem:memory-context");
    expect(typeof captured.text).toBe("function");
  });

  it("有记忆时，刷新后返回 <memory_context> 内容（回归：曾被 injectExcludeCurrentSession 提前 return 吞掉）", async () => {
    const captured = setup(async () => ({ success: true, memories: [makeMemory()] }));
    // 首次调用触发异步刷新，返回旧缓存（空）
    expect(captured.text({})).toBe("");
    // 等异步刷新完成
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rendered = captured.text({});
    expect(rendered).toContain("<memory_context>");
    expect(rendered).toContain("项目使用 pnpm workspaces");
  });

  it("injectExcludeCurrentSession 默认 true 时，仍应注入（不是直接返回空）", async () => {
    const captured = setup(async () => ({ success: true, memories: [makeMemory()] }));
    expect(mockGetConfig().injectExcludeCurrentSession).toBe(true);
    captured.text({});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(captured.text({})).not.toBe("");
  });

  it("无记忆时不注入（返回空串）", async () => {
    const captured = setup(async () => ({ success: true, memories: [] }));
    captured.text({});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(captured.text({})).toBe("");
  });

  it("listMemories 失败时静默降级为空串，不抛异常", async () => {
    const captured = setup(async () => ({ success: false, error: "db down", memories: [] }));
    captured.text({});
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(captured.text({})).toBe("");
  });
});
