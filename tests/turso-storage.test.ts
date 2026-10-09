// 存储层单测：向量往返、分片轮换、写锁、会话检索（临时目录，不碰真实 ./data）
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "../src/types.js";

// config mock：dataPath 指向临时目录
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
const { tursoShardManager } = await import("../src/services/turso/shard-manager.js");
const { getProjectTagInfo, getUserTagInfo } = await import("../src/services/tags.js");

// 确定性嵌入：同文本同向量，归一化
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

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "dsh-mem-storage-"));
  testCfg.dataPath = base;
  client = new LocalMemoryClient(fakeEmbedder);
});

afterAll(async () => {
  await client.close();
  rmSync(base, { recursive: true, force: true });
});

function projectTag(dirName: string): { tag: string; dir: string } {
  const dir = join(base, dirName);
  const info = getProjectTagInfo(dir);
  return { tag: info.tag, dir };
}

describe("LocalMemoryClient 存储往返", () => {
  it("addMemory 后 searchMemories 命中原文", async () => {
    const p = projectTag("basic");
    const add = await client.addMemory("unique-quantum-compiler", p.tag, {
      type: "tech",
      tags: ["compiler", "quantum"],
      source: "manual",
    });
    if (!add.success) throw new Error("addMemory failed");
    expect(add.id).toMatch(/^mem_/);

    const search = await client.searchMemories("unique-quantum-compiler", p.tag, "project");
    expect(search.success).toBe(true);
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results[0]!.memory).toBe("unique-quantum-compiler");
    expect(search.results[0]!.similarity).toBeGreaterThan(0.9);
    expect(search.results[0]!.containerTag).toBe(p.tag);
  });

  it("listMemories 返回全部并按时间倒序", async () => {
    const p = projectTag("list");
    await client.addMemory("alpha-first", p.tag);
    await client.addMemory("beta-second", p.tag);
    const list = await client.listMemories(p.tag, 20, "project");
    expect(list.success).toBe(true);
    expect(list.memories.length).toBe(2);
    expect(list.memories[0]!.createdAt).toBeGreaterThanOrEqual(list.memories[1]!.createdAt);
    expect(list.memories[0]!.tags).toEqual([]);
  });

  it("deleteMemory 删除后检索不再命中", async () => {
    const p = projectTag("delete");
    const add = await client.addMemory("to-be-forgotten-xz", p.tag);
    if (!add.success) throw new Error("addMemory failed");
    const memoryId = add.id;

    const before = await client.searchMemories("to-be-forgotten-xz", p.tag, "project");
    expect(before.results.some((r) => r.id === memoryId)).toBe(true);

    const del = await client.deleteMemory(memoryId);
    expect(del.success).toBe(true);

    const after = await client.searchMemories("to-be-forgotten-xz", p.tag, "project");
    expect(after.results.some((r) => r.id === memoryId)).toBe(false);
  });

  it("searchMemoriesBySessionID 按 sessionId 命中", async () => {
    const p = projectTag("session");
    await client.addMemory("session-scoped-memory", p.tag, { sessionId: "sess-42" });
    const result = await client.searchMemoriesBySessionID("sess-42", p.tag, 10);
    expect(result.success).toBe(true);
    expect(result.results.length).toBe(1);
    expect(result.results[0]!.memory).toBe("session-scoped-memory");
    expect(result.results[0]!.similarity).toBe(1.0);
  });

  it("all 范围同时检索 user 与 project 分片", async () => {
    const p = projectTag("allscope");
    const userInfo = getUserTagInfo(join(base, "allscope"));
    await client.addMemory("user-side-note-qq", userInfo.tag);
    await client.addMemory("project-side-note-qq", p.tag);

    const result = await client.searchMemories("side-note-qq", p.tag, "all");
    expect(result.success).toBe(true);
    const containers = new Set(result.results.map((r) => r.containerTag));
    expect(containers.has(userInfo.tag)).toBe(true);
    expect(containers.has(p.tag)).toBe(true);
  });
});

describe("分片轮换", () => {
  it("超过 maxVectorsPerShard 后自动建新分片", async () => {
    const p = projectTag("rotate");
    testCfg.maxVectorsPerShard = 2;
    try {
      for (const text of ["rotate-one", "rotate-two", "rotate-three"]) {
        const r = await client.addMemory(text, p.tag);
        expect(r.success).toBe(true);
      }
      const hash = p.tag.split("_").pop()!;
      const shards = await tursoShardManager.getAllShards("project", hash);
      expect(shards.length).toBe(2);
      expect(shards[0]!.isActive).toBe(false);
      expect(shards[1]!.isActive).toBe(true);
    } finally {
      testCfg.maxVectorsPerShard = 50000;
    }
  });
});

describe("scope 写锁", () => {
  it("同一 scope 串行执行", async () => {
    const hash = "0123456789abcdef";
    const order: string[] = [];
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    await Promise.all([
      tursoShardManager.withScopeWriteLock("project", hash, async () => {
        order.push("a-start");
        await delay(40);
        order.push("a-end");
      }),
      tursoShardManager.withScopeWriteLock("project", hash, async () => {
        order.push("b-start");
        await delay(10);
        order.push("b-end");
      }),
    ]);

    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("不同 scope 不互相阻塞", async () => {
    const order: string[] = [];
    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    await Promise.all([
      tursoShardManager.withScopeWriteLock("project", "1111111111111111", async () => {
        order.push("x-start");
        await delay(40);
        order.push("x-end");
      }),
      tursoShardManager.withScopeWriteLock("user", "2222222222222222", async () => {
        order.push("y-start");
        order.push("y-end");
      }),
    ]);

    expect(order.indexOf("y-end")).toBeLessThan(order.indexOf("x-end"));
  });
});
