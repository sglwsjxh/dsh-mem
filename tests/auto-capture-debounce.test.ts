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
// 捕获防抖回归：密集对话不丢上下文 + 定时器触发后捕获真的落库
// savePrompt 是浮动 promise，测试须先 await 落库
// 否则 SQLite 真实 I/O 与假定时器竞争会让捕获链随机空跑
import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { userPromptStore } from "../src/services/user-prompt-store.js";
import type { DshMemConfig } from "../src/types.js";
import type { MemoryClientLike, TagsLike, UserProfileManagerLike } from "../src/services/contracts.js";

beforeAll(() => {
  process.env.DSH_MEM_CONFIG_ISOLATED = "1";
});
afterAll(() => {
  delete process.env.DSH_MEM_CONFIG_ISOLATED;
});

/** 完整 DshMemConfig，dataPath 指向每个用例的临时目录 */
function makeCfg(dataPath: string): DshMemConfig {
  return {
    dataPath,
    embedding: { model: "m", baseUrl: "https://e.example/v1" },
    llm: { platform: "openai", baseUrl: "https://l.example/v1", model: "l", apiKey: "k", timeoutMs: 5000 },
    autoCaptureEnabled: true,
    autoCaptureMaxRetries: 3,
    autoCaptureMaxContext: 131072,
    similarityThreshold: 0.5,
    maxMemories: 10,
    memoryDefaultScope: "project",
    deduplicationEnabled: true,
    deduplicationSimilarityThreshold: 0.85,
    autoCleanupEnabled: false, // 关闭自动清理，避免 6h 定时器干扰 fakeTimers 计数
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

// vi.mock 工厂引用外部变量须经 vi.hoisted 中转
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
  getConfig: mockGetConfig,
  initConfig: () => mockGetConfig(),
  isConfigured: () => true,
  resetConfig: () => {},
  CONFIG_PATH: "unused",
}));

// userPromptStore 单例的 dbPath 来自 getConfig，每用例 reset 后重连
import { apply, installPluginDeps } from "../src/plugin.js";

function makeUserMessageEvent(messageId: string, text: string): SessionEvent {
  return {
    type: "user/message",
    data: { id: messageId, content: [{ type: "text", text }], source: { kind: "user" } },
  } as unknown as SessionEvent;
}

function makeAssistantEvent(text: string): SessionEvent {
  return {
    type: "assistant/message",
    data: { message: { content: [{ type: "text", text }] } },
  } as unknown as SessionEvent;
}

function makeTurnEndEvent(): SessionEvent {
  return { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } } as unknown as SessionEvent;
}

describe("自动捕获防抖", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh-mem-debounce-"));
    setTestCfg(makeCfg(join(dir, "data")));
    userPromptStore.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
    setTestCfg(null);
    userPromptStore.reset();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 装配并观测 addMemory 调用（捕获链的最终落点）与 dispose 回调 */
  function setup(): {
    handler: (session: unknown, event: SessionEvent) => void;
    added: string[];
    dispose: () => Promise<void>;
  } {
    const added: string[] = [];
    const memoryClient = {
      warmup: async () => {},
      isReady: () => true,
      getEmbeddingInitError: () => null,
      ensureStorageReady: async () => {},
      addMemory: async (content: string) => {
        added.push(content);
        return { success: true, id: `mem_${added.length}` };
      },
      searchMemories: async () => ({ success: true, results: [] }),
      listMemories: async () => ({ success: true, memories: [] }),
      deleteMemory: async () => ({ success: true }),
      searchMemoriesBySessionID: async () => ({ success: true, results: [] }),
      close: async () => {},
    } as MemoryClientLike;
    const tags: TagsLike = {
      user: { tag: "dshmem_user_x", displayName: "t", userName: "t", userEmail: "t@e.st" },
      project: { tag: "dshmem_project_x", displayName: "p", projectPath: dir, projectName: "p" },
    };
    const profileManager = {
      getActiveProfile: async () => null,
      createProfile: async () => {},
      updateProfile: async () => true,
      mergeProfileData: async (existing) => existing,
    } as UserProfileManagerLike;

    installPluginDeps({
      memoryClient,
      tags,
      llm: { complete: async () => JSON.stringify({ summary: "测试总结", type: "test", tags: ["t"] }) },
      profileManager,
    });

    let sessionHandler: ((session: unknown, event: SessionEvent) => void) | undefined;
    let disposeFn: (() => unknown) | undefined;
    const ctx = {
      tools: { register: () => () => {} },
      on: (event: string, handler: (session: unknown, e: SessionEvent) => void) => {
        if (event === "session/event") sessionHandler = handler;
        return () => {};
      },
      systemPrompt: { context: () => () => {} },
      effect: (fn: () => unknown) => {
        const cleanup = fn();
        if (typeof cleanup === "function") disposeFn = cleanup as () => unknown;
        return () => {};
      },
    } as unknown as Context;
    apply(ctx, { workspaceRoot: dir });
    if (!sessionHandler) throw new Error("session/event handler 未注册");
    return {
      handler: sessionHandler,
      added,
      dispose: async () => {
        await disposeFn?.();
      },
    };
  }

  /** 落库变成确定前置：plugin 的 savePrompt 是浮动 promise，这里幂等补一次并 await */
  async function fireUserMessage(
    handler: (session: unknown, event: SessionEvent) => void,
    session: unknown,
    sessionId: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    handler(session, makeUserMessageEvent(messageId, text));
    await userPromptStore.savePrompt(sessionId, messageId, dir, text);
  }

  it("防抖定时器在密集轮次间被重置，但不会永久饿死（10s 后仍触发）", async () => {
    vi.useFakeTimers();
    const { handler, added } = setup();
    const session = { id: "sess-dense", header: { cwd: dir } };

    for (let i = 1; i <= 3; i++) {
      await fireUserMessage(handler, session, "sess-dense", `m${i}`, `第 ${i} 轮用户输入`);
      handler(session, makeAssistantEvent(`第 ${i} 轮助手回复`));
      handler(session, makeTurnEndEvent());
      await vi.advanceTimersByTimeAsync(1000);
    }

    await vi.advanceTimersByTimeAsync(11000);
    await vi.runOnlyPendingTimersAsync();

    expect(added.length).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("单轮对话 10s 后定时器触发并完成捕获", async () => {
    vi.useFakeTimers();
    const { handler, added } = setup();
    const session = { id: "sess-single", header: { cwd: dir } };

    await fireUserMessage(handler, session, "sess-single", "m1", "单轮输入");
    handler(session, makeAssistantEvent("单轮回复"));
    handler(session, makeTurnEndEvent());

    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(added).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(6000);
    expect(added).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("dispose 会清掉待触发的防抖定时器", async () => {
    vi.useFakeTimers();
    const { handler, added, dispose } = setup();
    const session = { id: "sess-dispose", header: { cwd: dir } };

    await fireUserMessage(handler, session, "sess-dispose", "m1", "输入");
    handler(session, makeTurnEndEvent());
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(11000);
    expect(added).toHaveLength(0);
    vi.useRealTimers();
  });
});
