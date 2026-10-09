// 远程嵌入服务测试：请求构造、dimensions 透传、错误处理、fail-fast
import { describe, expect, it, vi, afterEach } from "vitest";
import { EmbeddingService } from "../src/services/embedding.js";
import type { EmbeddingConfig } from "../src/types.js";

const BASE: EmbeddingConfig = {
  model: "test-model",
  baseUrl: "https://api.example.com/v1",
  apiKey: "plain-key",
  dimensions: 8,
};

function okEmbedding(values: number[]): unknown {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: values }] }),
  };
}

describe("EmbeddingService", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POST {base}/embeddings，带 model/input/apikey", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        captured = { url: String(url), init: init ?? {} };
        return okEmbedding([1, 0, 0, 0, 0, 0, 0, 0]);
      }),
    );
    const svc = new EmbeddingService(BASE);
    const vec = await svc.embed("hello");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(captured!.url).toBe("https://api.example.com/v1/embeddings");
    expect(captured!.init.method).toBe("POST");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer plain-key");
    const body = JSON.parse(String(captured!.init.body)) as { model: string; input: string[] };
    expect(body.model).toBe("test-model");
    expect(body.input).toEqual(["hello"]);
  });

  it("dimensions 配置了就透传给 API", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return okEmbedding([1, 0, 0, 0, 0, 0, 0, 0]);
      }),
    );
    const svc = new EmbeddingService({ ...BASE, dimensions: 2048 });
    await svc.embed("hello");
    expect(body!.dimensions).toBe(2048);
  });

  it("dimensions 未配置则不传该字段", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return okEmbedding([1, 0]);
      }),
    );
    const svc = new EmbeddingService({ ...BASE, dimensions: undefined });
    await svc.embed("hello");
    expect("dimensions" in body!).toBe(false);
  });

  it("apiKey 为 env:// 且变量缺失时报错，不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const svc = new EmbeddingService({ ...BASE, apiKey: "env://DSH_MEM_NO_SUCH_VAR_XYZ" });
    await expect(svc.embed("hello")).rejects.toThrow(/apikey 解析结果为空/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("HTTP 错误抛出并带状态码与响应体片段", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "invalid key",
      })),
    );
    const svc = new EmbeddingService(BASE);
    await expect(svc.embed("hello")).rejects.toThrow(/401/);
  });

  it("响应缺 data[0].embedding 报错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })),
    );
    const svc = new EmbeddingService(BASE);
    await expect(svc.embed("hello")).rejects.toThrow(/缺少 data\[0\]\.embedding/);
  });

  it("warmup 失败后 fail-fast（initError 置位拒绝重试）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, statusText: "boom", text: async () => "err" })),
    );
    const svc = new EmbeddingService(BASE);
    await expect(svc.warmup()).rejects.toThrow(/500/);
    expect(svc.initError).not.toBeNull();
    // 第二次 warmup 直接拒绝，不再发请求
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    await expect(svc.warmup()).rejects.toThrow(/500/);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });

  it("warmup 成功后 isReady 为 true", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okEmbedding([1, 0, 0, 0, 0, 0, 0, 0])));
    const svc = new EmbeddingService(BASE);
    expect(svc.isReady()).toBe(false);
    await svc.warmup();
    expect(svc.isReady()).toBe(true);
  });
});
