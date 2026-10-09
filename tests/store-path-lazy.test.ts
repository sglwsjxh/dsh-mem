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
// 存储路径解析回归：UserPromptStore 的 dbPath 首次使用时才从 getConfig().dataPath 解析，
// 目录缺失时自动创建，connect 不会自建父目录
import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DshMemConfig } from "../src/types.js";

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

// mock 就位后再加载被测单例
import { userPromptStore } from "../src/services/user-prompt-store.js";

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

describe("存储路径延迟绑定", () => {
  let dir: string;
  let dataPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh-mem-path-"));
    dataPath = join(dir, "not-created-yet");
    setTestCfg(makeCfg(dataPath));
    userPromptStore.reset();
  });

  afterEach(() => {
    setTestCfg(null);
    userPromptStore.reset();
    rmSync(dir, { recursive: true, force: true });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("首次 savePrompt 时才解析 dataPath 并自动建目录", async () => {
    // 目标目录此刻不存在
    expect(existsSync(dataPath)).toBe(false);

    const id = await userPromptStore.savePrompt("s-path", "m-1", dir, "延迟绑定内容");
    expect(id).toContain("prompt_");
    expect(existsSync(join(dataPath, "user-prompts.db"))).toBe(true);

    const uncaptured = await userPromptStore.getUncapturedPromptsForSession("s-path");
    expect(uncaptured).toHaveLength(1);
    expect(uncaptured[0]!.content).toBe("延迟绑定内容");
  });

  it("改配置后 reset 会重绑到新 dataPath", async () => {
    await userPromptStore.savePrompt("s-a", "m-1", dir, "旧目录内容");
    expect(existsSync(join(dataPath, "user-prompts.db"))).toBe(true);

    const newPath = join(dir, "other-data");
    setTestCfg(makeCfg(newPath));
    userPromptStore.reset();

    await userPromptStore.savePrompt("s-b", "m-1", dir, "新目录内容");
    expect(existsSync(join(newPath, "user-prompts.db"))).toBe(true);
    const rows = await userPromptStore.getUncapturedPromptsForSession("s-b");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe("新目录内容");
  });
});
