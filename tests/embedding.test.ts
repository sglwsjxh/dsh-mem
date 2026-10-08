// 嵌入契约测试：task 前缀、MRL 截断、门面分派、openai 请求构造（mock fetch）
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { TASK_QUERY_PREFIX, TASK_DOCUMENT_PREFIX, applyTaskPrefix, truncateAndNormalize, LocalEmbedder } from "../src/services/embedding-local.js";
import { buildEmbeddingsRequest, OpenAiEmbedder } from "../src/services/embedding-openai.js";
import { resetEmbeddingService, getEmbeddingService } from "../src/services/embedding.js";
import { initConfig, resetConfig } from "../src/config.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EmbeddingConfig } from "../src/types.js";

const PLAIN_CFG: EmbeddingConfig = { model: "text-embedding-3-small" };
const REMOTE_CFG: EmbeddingConfig = { ...PLAIN_CFG, baseUrl: "https://api.openai.com/v1", apiKey: "plain" };

// 写进 JSON 配置的路径要正斜杠，反斜杠是转义符
function jsonPath(p: string): string {
  return p.replace(/\\/g, "/");
}

describe("task 前缀（检索协议内置默认）", () => {
  it("query 前缀正确", () => {
    expect(applyTaskPrefix("太阳系最大行星", "query", PLAIN_CFG)).toBe(`${TASK_QUERY_PREFIX}太阳系最大行星`);
    expect(TASK_QUERY_PREFIX).toBe("task: search result | query: ");
  });

  it("document 前缀正确", () => {
    expect(applyTaskPrefix("木星是气态巨行星", "document", PLAIN_CFG)).toBe(`${TASK_DOCUMENT_PREFIX}木星是气态巨行星`);
    expect(TASK_DOCUMENT_PREFIX).toBe("title: none | text: ");
  });

  it("无 task 时原样返回", () => {
    expect(applyTaskPrefix("原文", undefined, PLAIN_CFG)).toBe("原文");
  });

  it("taskPrefixes 配置可覆盖内置前缀", () => {
    const cfg: EmbeddingConfig = { model: "m", taskPrefixes: { query: "q> " } };
    expect(applyTaskPrefix("查询", "query", cfg)).toBe("q> 查询");
    // document 未覆盖时仍用内置
    expect(applyTaskPrefix("文档", "document", cfg)).toBe(`${TASK_DOCUMENT_PREFIX}文档`);
  });
});

describe("MRL 截断 + L2 重归一化", () => {
  it("截断后范数为 1", () => {
    const v = new Float32Array(768);
    for (let i = 0; i < 768; i++) v[i] = Math.sin(i) * 0.5;
    const out = truncateAndNormalize(v, 256);
    expect(out).toHaveLength(256);
    let norm = 0;
    for (const x of out) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it("dimensions 不小于向量长度时原样返回", () => {
    const v = new Float32Array([3, 4]);
    expect(truncateAndNormalize(v, 768)).toBe(v);
  });

  it("零向量截断不产生 NaN", () => {
    const out = truncateAndNormalize(new Float32Array(8), 4);
    expect(out.every((x) => Number.isFinite(x))).toBe(true);
  });
});

describe("buildEmbeddingsRequest", () => {
  it("POST {base}/embeddings，Bearer 认证，input 带 task 前缀后的文本", () => {
    const { url, headers, body } = buildEmbeddingsRequest(
      REMOTE_CFG,
      "text-embedding-3-small",
      `${TASK_QUERY_PREFIX}查询`,
      "sk-e",
      "https://api.openai.com/v1"
    );
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(headers.Authorization).toBe("Bearer sk-e");
    const b = body as Record<string, unknown>;
    expect(b.model).toBe("text-embedding-3-small");
    expect(b.input).toBe(`${TASK_QUERY_PREFIX}查询`);
    expect(b.encoding_format).toBe("float");
    // embeddings 端点无 max_tokens
    expect(b.max_tokens).toBeUndefined();
  });

  it("baseUrl 为空回退官方端点", () => {
    const { url } = buildEmbeddingsRequest({ model: "any-model" }, "any-model", "x", "k", "");
    expect(url).toBe("https://api.openai.com/v1/embeddings");
  });
});

describe("OpenAiEmbedder（mock fetch）", () => {
  afterEach(() => vi.unstubAllGlobals());

  function okResponse(embedding: number[]): { ok: boolean; status: number; statusText: string; json: () => Promise<unknown> } {
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ data: [{ embedding }] }) };
  }

  it("warmup 探测请求通过后 isReady", async () => {
    const fetchMock = vi.fn(async () => okResponse([0.1, 0.2]));
    vi.stubGlobal("fetch", fetchMock);
    const embedder = new OpenAiEmbedder(REMOTE_CFG, "text-embedding-3-small");
    expect(embedder.isReady()).toBe(false);
    await embedder.warmup();
    expect(embedder.isReady()).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("warmup 失败置 initError（fail-fast，拒绝重试）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, statusText: "Unauthorized" })));
    const embedder = new OpenAiEmbedder(REMOTE_CFG, "text-embedding-3-small");
    await expect(embedder.warmup()).rejects.toThrow(/401/);
    expect(embedder.initError).toContain("401");
    // 第二次调用直接快速失败，不再发请求
    await expect(embedder.warmup()).rejects.toThrow(/401/);
  });

  it("embed 解析 data[0].embedding 为 Float32Array", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse([0.5, -0.5, 0.7])));
    // dimensions 调低以匹配 mock 响应，聚焦解析语义
    const embedder = new OpenAiEmbedder({ ...REMOTE_CFG, dimensions: 3 }, "text-embedding-3-small");
    const vec = await embedder.embed("内容");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec).toHaveLength(3);
    expect(vec[0]).toBeCloseTo(0.5, 6);
    expect(vec[1]).toBeCloseTo(-0.5, 6);
    expect(vec[2]).toBeCloseTo(0.7, 6);
  });

  it("embedding 维度小于配置 dimensions 时报错（配置错配早失败）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse([0.5, -0.5, 0.7])));
    const embedder = new OpenAiEmbedder({ ...REMOTE_CFG, dimensions: 768 }, "text-embedding-3-small");
    await expect(embedder.embed("内容")).rejects.toThrow(/小于配置 dimensions/);
  });

  it("apiKey 走 env:// 解析", async () => {
    process.env.DSH_MEM_EMB_KEY = "env-key";
    try {
      const fetchMock = vi.fn(async () => okResponse([1]));
      vi.stubGlobal("fetch", fetchMock);
      const embedder = new OpenAiEmbedder({ ...REMOTE_CFG, apiKey: "env://DSH_MEM_EMB_KEY" }, "text-embedding-3-small");
      await embedder.warmup();
      expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/embeddings", expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer env-key" }),
      }));
    } finally {
      delete process.env.DSH_MEM_EMB_KEY;
    }
  });
});

describe("LocalEmbedder 契约（mock 推理后端）", () => {
  it("warmup 失败 fail-fast", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "dsh-mem-le-")), "no-such-model.gguf");
    const embedder = new LocalEmbedder({ model: `file://${jsonPath(missing)}` }, missing);
    await expect(embedder.warmup()).rejects.toThrow(/不存在/);
    expect(embedder.initError).toBeTruthy();
    await expect(embedder.warmup()).rejects.toThrow();
  });

  it("embed 前缀注入 + 缓存生效", async () => {
    const embedder = new LocalEmbedder({ model: "hf://test/repo", dimensions: 4 }, "hf://test/repo");
    // 注入 mock extractor 模拟已初始化状态
    let calls = 0;
    (embedder as unknown as { extractor: unknown; _isReady: boolean }).extractor = async (text: string) => {
      calls++;
      expect([TASK_QUERY_PREFIX, TASK_DOCUMENT_PREFIX].some((p) => text.startsWith(p))).toBe(true);
      return { data: new Float32Array([1, 0, 0, 0]) };
    };
    (embedder as unknown as { _isReady: boolean })._isReady = true;
    const a = await embedder.embed("文本一", "document");
    const b = await embedder.embed("文本一", "document");
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it("file:// 目录无模型文件时校验失败", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mem-le-empty-"));
    const embedder = new LocalEmbedder({ model: `file://${jsonPath(dir)}` }, dir);
    await expect(embedder.warmup()).rejects.toThrow(/\.gguf/);
  });

  it("远程模型名传给本地嵌入器时报错", async () => {
    const embedder = new LocalEmbedder({ model: "text-embedding-3-small" }, "text-embedding-3-small");
    await expect(embedder.warmup()).rejects.toThrow(/远程模型名/);
  });
});

describe("EmbeddingService 门面", () => {
  beforeEach(() => {
    resetConfig();
    resetEmbeddingService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetConfig();
    resetEmbeddingService();
  });

  it("空 model 按 openai 兜底分派到远程实现", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mem-emb-"));
    initConfig(dir);
    const svc = getEmbeddingService();
    expect(svc.isReady()).toBe(false);
    expect(svc.initError).toBeNull();
  });

  it("远程形态分派到 OpenAiEmbedder（model/baseUrl 来自 embedding 段）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mem-emb-"));
    writeFileSync(
      join(dir, "config.jsonc"),
      `{ "embedding": { "model": "text-embedding-3-small", "baseUrl": "https://gw.example.com/v1", "apiKey": "plain" } }`,
      "utf-8"
    );
    initConfig(dir);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ data: [{ embedding: [1] }] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const svc = getEmbeddingService();
    expect(svc.isReady()).toBe(false);
    await svc.warmup();
    // 探测请求打到配置里的 baseUrl，证明分派到了 openai 实现
    expect(fetchMock).toHaveBeenCalledWith("https://gw.example.com/v1/embeddings", expect.anything());
  });

  it("file:// 形态分派到 LocalEmbedder（filesystem 定位）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mem-emb-"));
    const missing = join(dir, "no-such-model.gguf");
    writeFileSync(join(dir, "config.jsonc"), `{ "embedding": { "model": "file://${jsonPath(missing)}" } }`, "utf-8");
    initConfig(dir);
    const svc = getEmbeddingService();
    await expect(svc.warmup()).rejects.toThrow(/不存在/);
  });

  it("配置键变化时门面重建实例", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-mem-emb-"));
    initConfig(dir);
    const first = getEmbeddingService();
    resetConfig();
    const dir2 = mkdtempSync(join(tmpdir(), "dsh-mem-emb-"));
    writeFileSync(join(dir2, "config.jsonc"), `{ "embedding": { "dimensions": 512 } }`, "utf-8");
    initConfig(dir2);
    const second = getEmbeddingService();
    expect(second).not.toBe(first);
  });
});
