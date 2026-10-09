// LLM 客户端测试：三平台请求构造 + mock fetch 响应解析
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildOpenAiRequest,
  buildAnthropicRequest,
  buildGeminiRequest,
  createLlmClient,
  LlmError,
  GEMINI_DEFAULT_BASE_URL,
} from "../src/services/llm-client.js";
import type { LlmConfig, LlmMessage } from "../src/types.js";

const BASE: LlmConfig = {
  platform: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  apiKey: "plain-key",
  timeoutMs: 5000,
};

const MESSAGES: LlmMessage[] = [
  { role: "user", content: "你好" },
  { role: "assistant", content: "你好呀" },
  { role: "user", content: "再见" },
];

describe("buildOpenAiRequest", () => {
  it("POST {base}/chat/completions，system 前置", () => {
    const { url, headers, body } = buildOpenAiRequest(BASE, MESSAGES, "你是总结器", "sk-x");
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(headers.Authorization).toBe("Bearer sk-x");
    const b = body as { messages: Array<{ role: string }>; model: string; max_tokens: number };
    expect(b.model).toBe("gpt-4o-mini");
    expect(b.messages[0]!.role).toBe("system");
    expect(b.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(b.max_tokens).toBeGreaterThan(0);
  });

  it("无 system 时不插入 system 消息", () => {
    const { body } = buildOpenAiRequest(BASE, MESSAGES);
    expect((body as { messages: unknown[] }).messages).toHaveLength(3);
  });

  it("baseUrl 尾斜杠被去除", () => {
    const { url } = buildOpenAiRequest({ ...BASE, baseUrl: "https://api.openai.com/v1/" }, MESSAGES);
    expect(url).not.toContain("//chat");
  });
});

describe("buildAnthropicRequest", () => {
  it("POST {base}/messages，x-api-key + anthropic-version", () => {
    const cfg: LlmConfig = { ...BASE, platform: "anthropic", baseUrl: "https://api.anthropic.com/v1" };
    const { url, headers, body } = buildAnthropicRequest(cfg, MESSAGES, "sys", "sk-ant");
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers["x-api-key"]).toBe("sk-ant");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const b = body as { system?: string; max_tokens: number; messages: Array<{ role: string }> };
    expect(b.system).toBe("sys");
    expect(b.max_tokens).toBeGreaterThan(0);
    expect(b.messages.every((m) => m.role === "user" || m.role === "assistant")).toBe(true);
  });
});

describe("buildGeminiRequest", () => {
  it("POST {base}/models/{model}:generateContent，assistant→model 角色", () => {
    const cfg: LlmConfig = { ...BASE, platform: "gemini", baseUrl: "" };
    const { url, headers, body } = buildGeminiRequest(cfg, MESSAGES, "sys", "g-key");
    expect(url).toBe(`${GEMINI_DEFAULT_BASE_URL}/models/gpt-4o-mini:generateContent`);
    expect(headers["x-goog-api-key"]).toBe("g-key");
    const b = body as { contents: Array<{ role: string; parts: Array<{ text: string }>; }>; systemInstruction?: { parts: Array<{ text: string }> } };
    expect(b.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    expect(b.contents[0]!.parts[0]!.text).toBe("你好");
    expect(b.systemInstruction?.parts[0]?.text).toBe("sys");
  });
});

describe("createLlmClient.complete", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("openai：解析 choices[0].message.content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "总结结果" } }] }),
    })));
    const client = createLlmClient(BASE);
    await expect(client.complete(MESSAGES, "sys")).resolves.toBe("总结结果");
  });

  it("anthropic：拼接 content[].text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }] }),
    })));
    const client = createLlmClient({ ...BASE, platform: "anthropic" });
    await expect(client.complete(MESSAGES)).resolves.toBe("第一段第二段");
  });

  it("gemini：解析 candidates[0].content.parts[].text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "回答" }] } }] }),
    })));
    const client = createLlmClient({ ...BASE, platform: "gemini" });
    await expect(client.complete(MESSAGES)).resolves.toBe("回答");
  });

  it("HTTP 错误抛 LlmError 且带 platform", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: async () => "rate limited",
    })));
    const client = createLlmClient(BASE);
    await expect(client.complete(MESSAGES)).rejects.toMatchObject({ platform: "openai", name: "LlmError" });
  });

  it("网络错误归一成 LlmError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const client = createLlmClient({ ...BASE, platform: "gemini" });
    await expect(client.complete(MESSAGES)).rejects.toMatchObject({ platform: "gemini", name: "LlmError" });
  });

  it("openai 响应缺 content 抛 LlmError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
    })));
    const client = createLlmClient(BASE);
    await expect(client.complete(MESSAGES)).rejects.toBeInstanceOf(LlmError);
  });

  it("reasoning 模型 content 为 null 时回退 reasoning 字段", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: null, reasoning: 'Thinking...\n\n{"summary": "修了bug", "type": "bug-fix", "tags": ["x"]}' } }],
      }),
    })));
    const client = createLlmClient(BASE);
    await expect(client.complete(MESSAGES, "sys")).resolves.toContain('"summary": "修了bug"');
  });

  it("content 与 reasoning 全空仍抛 LlmError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: null, reasoning: "" } }] }),
    })));
    const client = createLlmClient(BASE);
    await expect(client.complete(MESSAGES)).rejects.toBeInstanceOf(LlmError);
  });

  it("max_tokens 提升至 4096（reasoning 模型思考预算）", () => {
    const { body } = buildOpenAiRequest(BASE, MESSAGES, "sys", "sk-x");
    expect((body as { max_tokens: number }).max_tokens).toBe(4096);
  });

  it("请求带 AbortSignal.timeout 超时语义（timeoutMs 透传）", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      captured = init;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    }));
    const client = createLlmClient({ ...BASE, timeoutMs: 12345 });
    await client.complete(MESSAGES);
    const signal = captured?.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("env:// 密钥解析失败抛 LlmError", async () => {
    const client = createLlmClient({ ...BASE, apiKey: "env://DSH_MEM_NO_SUCH_VAR" });
    await expect(client.complete(MESSAGES)).rejects.toMatchObject({ name: "LlmError" });
  });
});
