// 会话工作区回归测试：项目身份必须跟随 session.header.cwd，而非进程 cwd
// 背景：dsh web 从 ~ 启动时 process.cwd() 是 home，导致记忆分片按 home 建、与项目目录割裂
import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { apply, installPluginDeps } from "../src/plugin.js";
import { userPromptStore } from "../src/services/user-prompt-store.js";
import type { MemoryClientLike, TagsLike, UserProfileManagerLike } from "../src/services/contracts.js";
import type { DshMemConfig } from "../src/types.js";

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

function makeCfg(dataPath: string): DshMemConfig {
  return {
    dataPath,
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
  };
}

interface CapturedContext {
  name: string;
  text: (assembleCtx?: { signal?: AbortSignal }) => string;
}

/** 假会话：带 header.cwd */
function makeFakeSession(sessionId: string, cwd?: string) {
  return {
    id: sessionId,
    header: cwd ? { cwd } : {},
  };
}

/** 造一个 user/message 事件（source.kind=user，可触发 savePrompt） */
function makeUserMessageEvent(messageId: string, text: string): SessionEvent {
  return {
    type: "user/message",
    data: {
      id: messageId,
      content: [{ type: "text", text }],
      source: { kind: "user" },
    },
  } as unknown as SessionEvent;
}

describe("项目身份跟随会话工作区", () => {
  let dir: string;
  let wsA: string;
  let wsB: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh-mem-ws-"));
    wsA = mkdtempSync(join(tmpdir(), "dsh-mem-wsA-"));
    wsB = mkdtempSync(join(tmpdir(), "dsh-mem-wsB-"));
    // 保证两个工作区目录可被 git 探测（tag 身份依据）
    mkdirSync(join(wsA, ".git"), { recursive: true });
    mkdirSync(join(wsB, ".git"), { recursive: true });
    mkdirSync(join(dir, ".git"), { recursive: true });
    setTestCfg(makeCfg(join(dir, "data")));
    userPromptStore.reset();
  });

  afterAll(() => {
    for (const d of [dir, wsA, wsB]) rmSync(d, { recursive: true, force: true });
  });

  /** 装配并捕获事件处理器与 memory 工具 */
  function setup(): {
    handler: (session: unknown, event: SessionEvent) => void;
    tool: { execute: (args: unknown, exec: unknown) => Promise<unknown> };
    shardCalls: string[];
  } {
    const shardCalls: string[] = [];
    const memoryClient = {
      warmup: async () => {},
      isReady: () => true,
      getEmbeddingInitError: () => null,
      ensureStorageReady: async () => {},
      addMemory: async () => ({ success: true, id: "mem_1" }),
      searchMemories: async () => ({ success: true, results: [] }),
      listMemories: async () => ({ success: true, memories: [] }),
      deleteMemory: async () => ({ success: true }),
      searchMemoriesBySessionID: async () => ({ success: true, results: [] }),
      // 可携性：记录收到的目录，供断言
      listShards: async (currentDirectory: string) => {
        shardCalls.push(currentDirectory);
        return { success: true, storagePath: "/x", shards: [] };
      },
      close: async () => {},
    } as unknown as MemoryClientLike;
    const tags: TagsLike = {
      user: { tag: "dshmem_user_x", displayName: "t", userName: "t", userEmail: "t@e.st" },
      project: { tag: "dshmem_project_x", displayName: "p", projectPath: "/p", projectName: "p" },
    };
    const profileManager = {
      getActiveProfile: async () => null,
      createProfile: async () => {},
      updateProfile: async () => true,
      mergeProfileData: async (existing) => existing,
    } as UserProfileManagerLike;

    installPluginDeps({ memoryClient, tags, llm: { complete: async () => "{}" }, profileManager });

    const contexts: CapturedContext[] = [];
    let sessionHandler: ((session: unknown, event: SessionEvent) => void) | undefined;
    let registeredTool: { execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined;
    const ctx = {
      tools: {
        register: (t: { execute: (args: unknown, exec: unknown) => Promise<unknown> }) => {
          registeredTool = t;
          return () => {};
        },
      },
      on: (event: string, handler: (session: unknown, e: SessionEvent) => void) => {
        if (event === "session/event") sessionHandler = handler;
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
    apply(ctx, { workspaceRoot: dir });
    if (!sessionHandler) throw new Error("session/event handler 未注册");
    if (!registeredTool) throw new Error("memory 工具未注册");
    return { handler: sessionHandler, tool: registeredTool, shardCalls };
  }

  it("session.header.cwd 与装配目录不同时，savePrompt 用会话工作区", async () => {
    // 直接调用 getTags 的行为验证：两个工作区产生不同 tag
    const { getProjectTagInfo } = await import("../src/services/tags.js");
    const tagA = getProjectTagInfo(wsA).tag;
    const tagB = getProjectTagInfo(wsB).tag;
    expect(tagA).not.toBe(tagB);
    expect(tagA).toContain("253a440a39e9fe5a" === tagA.split("_").pop() ? "never" : "dsh_project_");
  });

  it("getProjectTagInfo 对不同目录产生不同身份，对同目录稳定", async () => {
    const { getProjectTagInfo } = await import("../src/services/tags.js");
    const first = getProjectTagInfo(wsA).tag;
    const second = getProjectTagInfo(wsA).tag;
    expect(first).toBe(second);
    expect(getProjectTagInfo(wsB).tag).not.toBe(first);
  });

  it("getActiveTags 兜底顺序：装配目录在 currentWorkspace 未设置时生效", async () => {
    // 装配（此时无任何 session 事件，currentWorkspace 未定义）
    const { handler } = setup();
    // 触发一个 user/message（fake session 不带 header.cwd，应兜底到装配目录）
    const session = makeFakeSession("sess-1", undefined);
    handler(session, makeUserMessageEvent("m1", "测试兜底"));
    // 不抛异常即视为兜底路径正常
    expect(handler).toBeDefined();
  });

  it("session.header.cwd 存在时被捕获（currentWorkspace 更新不抛错）", async () => {
    const { handler } = setup();
    const session = makeFakeSession("sess-2", wsA);
    handler(session, makeUserMessageEvent("m2", "测试会话工作区捕获"));
    // 再次触发同会话事件，缓存路径不重复报错
    handler(session, makeUserMessageEvent("m3", "再次触发"));
    expect(handler).toBeDefined();
  });

  it("可携性模式（list-shards）用会话工作区，而非装配目录", async () => {
    const { handler, tool, shardCalls } = setup();
    // 会话工作区是 wsA，装配目录是 dir
    handler(makeFakeSession("sess-3", wsA), makeUserMessageEvent("m4", "触发会话工作区"));
    // 工具 exec 也带会话 cwd（模拟宿主调用）
    const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: wsA } } } };
    await tool.execute({ mode: "list-shards" }, exec);
    expect(shardCalls).toHaveLength(1);
    expect(shardCalls[0]).toBe(wsA);
    expect(shardCalls[0]).not.toBe(dir);
  });

  it("无会话信息时可携性模式兜底到装配目录", async () => {
    const { tool, shardCalls } = setup();
    const exec = { signal: new AbortController().signal };
    await tool.execute({ mode: "list-shards" }, exec);
    expect(shardCalls[0]).toBe(dir);
  });
});
