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
// 捕获状态收敛回归测试
// 背景：两步写状态非原子，中断留下 captured=2，重启重捕获会写重复记忆
// 记忆已落库后状态更新抛错，不得进重试分支
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DshMemConfig } from "../src/types.js";
import { UserPromptStore } from "../src/services/user-prompt-store.js";

// 配置只读固定路径，测试用 vi.hoisted 状态注入
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
    // 模拟 claim 后进程中断
    const stale = await store.listInconsistentCaptures();
    expect(stale).toHaveLength(1);
    expect(stale[0]!.id).toBe(id);
    expect(stale[0]!.captured).toBe(2);
  });

  it("claim 后重启（reset）会把 captured=2 释放回 0", async () => {
    const id = await store.savePrompt("s3", "m1", dir, "内容");
    await store.claimPrompt(id);
    await store.close();
    // 重开同一库模拟重启
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
