// 捕获状态收敛回归测试
// 背景：linkMemoryToPrompt + markAsCaptured 两步非原子，进程在中间中断会留下 captured=2；
// 重启时被重置为 0 → 重新捕获 → 写出重复记忆。
// 另：addMemory 成功后若状态更新抛错，绝不能进重试分支（会重复写记忆）。
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DshMemConfig } from "../src/types.js";
import { UserPromptStore } from "../src/services/user-prompt-store.js";

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

describe("捕获状态收敛", () => {
  let dir: string;
  let store: UserPromptStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh-mem-converge-"));
    setTestCfg({
      dataPath: dir,
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
    });
    store = new UserPromptStore();
  });

  afterEach(async () => {
    await store.close();
    setTestCfg(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("markCapturedWithMemory 一次性写 captured=1 与 linked_memory_id", async () => {
    const id = await store.savePrompt("s1", "m1", dir, "内容");
    await store.claimPrompt(id);
    await store.markCapturedWithMemory(id, "mem_abc");

    const row = await store.getUncapturedPromptsForSession("s1");
    expect(row).toHaveLength(0);
    expect(await store.listInconsistentCaptures()).toHaveLength(0);
  });

  it("残留 captured=2 可被 listInconsistentCaptures 查出（中断现场）", async () => {
    const id = await store.savePrompt("s2", "m1", dir, "内容");
    await store.claimPrompt(id);
    // 模拟：claim 后进程中断，link/mark 都没执行
    const stale = await store.listInconsistentCaptures();
    expect(stale).toHaveLength(1);
    expect(stale[0]!.id).toBe(id);
    expect(stale[0]!.captured).toBe(2);
  });

  it("claim 后重启（reset）会把 captured=2 释放回 0", async () => {
    const id = await store.savePrompt("s3", "m1", dir, "内容");
    await store.claimPrompt(id);
    await store.close();
    // 重开同一库，模拟进程重启
    const reopened = new UserPromptStore();
    const pending = await reopened.getUncapturedPromptsForSession("s3");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(id);
    expect(pending[0]!.captured).toBe(0);
    await reopened.close();
  });

  it("已 captured=1 的行不会再被捕获（防重复记忆）", async () => {
    const id = await store.savePrompt("s4", "m1", dir, "内容");
    await store.claimPrompt(id);
    await store.markCapturedWithMemory(id, "mem_xyz");
    expect(await store.getUncapturedPromptsForSession("s4")).toHaveLength(0);
  });
});
