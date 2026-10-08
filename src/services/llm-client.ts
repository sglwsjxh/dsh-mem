// dsh-mem 内部 LLM 客户端：openai / anthropic / gemini 三种 API 风格，fetch 直调
import type { LlmClient, LlmConfig, LlmMessage } from "../types.js";
import { resolveSecretValue } from "./secret-resolver.js";

/** LLM 调用错误：统一形态，带 platform 便于上层区分 */
export class LlmError extends Error {
  readonly platform: LlmConfig["platform"];
  constructor(platform: LlmConfig["platform"], message: string) {
    super(`[${platform}] ${message}`);
    this.name = "LlmError";
    this.platform = platform;
  }
}

interface LlmResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** gemini 默认端点；config.json.example 的 llm.baseUrl 未写时兜底 */
export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** openai 请求体构造（导出供测试） */
export function buildOpenAiRequest(config: LlmConfig, messages: LlmMessage[], system?: string, apiKey?: string): { url: string; headers: Record<string, string>; body: unknown } {
  const base = config.baseUrl.replace(/\/+$/, "");
  const merged: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  if (system) merged.push({ role: "system", content: system });
  for (const m of messages) merged.push({ role: m.role, content: m.content });
  return {
    url: `${base}/chat/completions`,
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: { model: config.model, messages: merged, max_tokens: 1024 },
  };
}

/** anthropic 请求体构造（导出供测试） */
export function buildAnthropicRequest(config: LlmConfig, messages: LlmMessage[], system?: string, apiKey?: string): { url: string; headers: Record<string, string>; body: unknown } {
  const base = (config.baseUrl || "https://api.anthropic.com/v1").replace(/\/+$/, "");
  return {
    url: `${base}/messages`,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: {
      model: config.model,
      max_tokens: 1024,
      ...(system ? { system } : {}),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    },
  };
}

/** gemini 请求体构造（导出供测试） */
export function buildGeminiRequest(config: LlmConfig, messages: LlmMessage[], system?: string, apiKey?: string): { url: string; headers: Record<string, string>; body: unknown } {
  const base = (config.baseUrl || GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  return {
    url: `${base}/models/${config.model}:generateContent`,
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey ?? "" },
    body: {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    },
  };
}

async function readErrorBody(response: LlmResponseLike): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return response.statusText;
  }
}

function extractText(platform: LlmConfig["platform"], data: unknown): string {
  if (platform === "openai") {
    const d = data as { choices?: Array<{ message?: { content?: string } }> };
    const content = d.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new LlmError(platform, "响应缺少 choices[0].message.content");
    return content;
  }
  if (platform === "anthropic") {
    const d = data as { content?: Array<{ type?: string; text?: string }> };
    const parts = (d.content ?? []).filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text as string);
    if (parts.length === 0) throw new LlmError(platform, "响应缺少 content[].text");
    return parts.join("");
  }
  const d = data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const parts = (d.candidates?.[0]?.content?.parts ?? []).filter((p) => typeof p.text === "string").map((p) => p.text as string);
  if (parts.length === 0) throw new LlmError(platform, "响应缺少 candidates[0].content.parts[].text");
  return parts.join("");
}

/**
 * 三平台 LLM 客户端。0.1.0 决策：fetch 直调，不依赖宿主 llm 服务
 * system 作为单轮请求的 system prompt 注入
 */
export function createLlmClient(config: LlmConfig): LlmClient {
  return {
    async complete(messages, system) {
      let apiKey: string | undefined;
      try {
        apiKey = resolveSecretValue(config.apiKey);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new LlmError(config.platform, `apiKey 解析失败: ${msg}`);
      }
      const build = config.platform === "openai" ? buildOpenAiRequest : config.platform === "anthropic" ? buildAnthropicRequest : buildGeminiRequest;
      const { url, headers, body } = build(config, messages, system, apiKey);
      let response: LlmResponseLike;
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new LlmError(config.platform, `请求失败: ${msg}`);
      }
      if (!response.ok) {
        throw new LlmError(config.platform, `HTTP ${response.status}: ${await readErrorBody(response)}`);
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new LlmError(config.platform, `响应不是合法 JSON: ${msg}`);
      }
      return extractText(config.platform, data);
    },
  };
}
