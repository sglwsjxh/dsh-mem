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
// 导出导入单测：schema 校验、隐私脱敏、ID 冲突拒绝、dryRun
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "../src/types.js";

const testCfg = {
  dataPath: "",
  embedding: { model: "test-model", dimensions: 8 },
  similarityThreshold: 0.5,
  maxMemories: 10,
  memoryDefaultScope: "project" as const,
  maxVectorsPerShard: 50000,
  databaseEncryptionEnabled: false,
  databaseEncryptionKey: undefined,
};
vi.mock("../src/config.js", () => ({
  getConfig: () => testCfg,
  DATA_DIR: testCfg.dataPath,
  resetConfig: () => {},
  initConfig: () => testCfg,
}));

const { LocalMemoryClient } = await import("../src/services/memory-client.js");
const { getProjectTagInfo } = await import("../src/services/tags.js");

function seededVector(text: string): Float32Array {
  const dims = testCfg.embedding.dimensions;
  const v = new Float32Array(dims);
  for (let i = 0; i < text.length; i++) v[i % dims]! += (text.charCodeAt(i) % 7) + 1;
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) v[0] = 1;
  else for (let i = 0; i < dims; i++) v[i] = v[i]! / norm;
  return v;
}

const fakeEmbedder: Embedder = {
  async warmup() {},
  async embed(text: string) {
    return seededVector(text);
  },
  isReady: () => true,
  initError: null,
  async dispose() {},
};

let base: string;
let client: InstanceType<typeof LocalMemoryClient>;
let projectTag: string;

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "dsh-mem-portability-"));
  testCfg.dataPath = base;
  client = new LocalMemoryClient(fakeEmbedder);
  const info = getProjectTagInfo(join(base, "proj"));
  projectTag = info.tag;
});

afterAll(async () => {
  await client.close();
  rmSync(base, { recursive: true, force: true });
});

describe("exportMemories", () => {
  it("导出 JSON 文档，包含 schemaVersion 与记忆列表", async () => {
    await client.addMemory("exportable-alpha-content", projectTag, { tags: ["export"] });
    const outputPath = join(base, "export.json");
    const result = await client.exportMemories({ currentDirectory: join(base, "proj"), outputPath });

    expect(result.success).toBe(true);
    expect(result.count).toBeGreaterThan(0);

    const doc = JSON.parse(readFileSync(outputPath, "utf-8"));
    expect(doc.schemaVersion).toBe(1);
    expect(doc.plugin.package).toBe("dsh-mem");
    expect(doc.source.containerTag).toBe(projectTag);
    expect(doc.memories.some((m: { content: string }) => m.content === "exportable-alpha-content")).toBe(true);
  });

  it("private 区域被脱敏导出", async () => {
    await client.addMemory("visible-part <private>hidden-secret</private>", projectTag);
    const outputPath = join(base, "export-private.json");
    const result = await client.exportMemories({ currentDirectory: join(base, "proj"), outputPath });
    expect(result.success).toBe(true);

    const doc = JSON.parse(readFileSync(outputPath, "utf-8"));
    const hit = doc.memories.find((m: { content: string }) => m.content.includes("[REDACTED]"));
    expect(hit).toBeTruthy();
    expect(hit.content).not.toContain("hidden-secret");
  });
});

describe("importMemories", () => {
  it("dryRun 只统计不写库", async () => {
    await client.addMemory("dry-run-source-content", projectTag);
    const outputPath = join(base, "dry.json");
    await client.exportMemories({ currentDirectory: join(base, "proj"), outputPath });

    // 换空项目做导入目标
    const targetInfo = getProjectTagInfo(join(base, "target"));
    const result = await client.importMemories({
      currentDirectory: join(base, "target"),
      inputPath: outputPath,
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.imported).toBeGreaterThan(0);

    const list = await client.listMemories(targetInfo.tag, 100, "project");
    expect(list.memories.length).toBe(0);
  });

  it("真实导入后记忆落在目标项目下", async () => {
    await client.addMemory("real-import-content-zz", projectTag);
    const outputPath = join(base, "real.json");
    await client.exportMemories({ currentDirectory: join(base, "proj"), outputPath });

    const targetInfo = getProjectTagInfo(join(base, "target2"));
    const result = await client.importMemories({
      currentDirectory: join(base, "target2"),
      inputPath: outputPath,
    });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.imported).toBeGreaterThan(0);

    const list = await client.listMemories(targetInfo.tag, 100, "project");
    expect(list.memories.some((m) => m.content === "real-import-content-zz")).toBe(true);
  });

  it("ID 冲突时拒绝导入", async () => {
    await client.addMemory("conflict-content-aa", projectTag);
    const outputPath = join(base, "conflict.json");
    await client.exportMemories({ currentDirectory: join(base, "proj"), outputPath });

    const result = await client.importMemories({
      currentDirectory: join(base, "proj"),
      inputPath: outputPath,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("already exist");
    expect(result.rejected?.length).toBeGreaterThan(0);
  });

  it("非法文档被 schema 拒绝", async () => {
    const badPath = join(base, "bad.json");
    writeFileSync(badPath, JSON.stringify({ schemaVersion: 1, memories: "not-an-array" }), "utf-8");

    const result = await client.importMemories({
      currentDirectory: join(base, "proj"),
      inputPath: badPath,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid export document");
  });

  it("更高 schemaVersion 拒绝导入", async () => {
    const futurePath = join(base, "future.json");
    writeFileSync(futurePath, JSON.stringify({ schemaVersion: 99, memories: [] }), "utf-8");

    const result = await client.importMemories({
      currentDirectory: join(base, "proj"),
      inputPath: futurePath,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unsupported export schemaVersion");
  });
});
