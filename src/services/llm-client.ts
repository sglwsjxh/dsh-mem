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

// LLM 客户端：openai anthropic gemini 三种风格，fetch 直调
import type { LlmClient, LlmConfig, LlmMessage } from "../types.js";
import { resolveSecretValue } from "./secret-resolver.js";

/** LLM 调用错误，带 platform 便于上层区分 */
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

/** gemini 默认端点，baseUrl 未配置时兜底 */
export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** openai 请求体构造，导出供测试 */
export function buildOpenAiRequest(config: LlmConfig, messages: LlmMessage[], system?: string, apiKey?: string): { url: string; headers: Record<string, string>; body: unknown } {
  const base = config.baseUrl.replace(/\/+$/, "");
  const merged: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  if (system) merged.push({ role: "system", content: system });
  for (const m of messages) merged.push({ role: m.role, content: m.content });
  return {
    url: `${base}/chat/completions`,
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    // 4096：reasoning 模型的思考过程计入输出预算，1024 会在思考阶段耗尽
    body: { model: config.model, messages: merged, max_tokens: 4096 },
  };
}

/** anthropic 请求体构造，导出供测试 */
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

/** gemini 请求体构造，导出供测试 */
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
    const d = data as { choices?: Array<{ message?: { content?: string | null; reasoning?: unknown } }> };
    const message = d.choices?.[0]?.message;
    // reasoning 模型会把输出全放进 reasoning 字段、content 留 null，此时从 reasoning 抢救 JSON，否则捕获链必失败
    // 该回退是刻意保留的修复，勿删
    const content = message?.content;
    if (typeof content === "string" && content.trim().length > 0) return content;
    const reasoning = message?.reasoning;
    if (typeof reasoning === "string" && reasoning.trim().length > 0) return reasoning;
    if (reasoning && typeof reasoning === "object") {
      const parts = (reasoning as { text?: unknown }[]).filter((p) => typeof p?.text === "string").map((p) => p.text as string);
      if (parts.length > 0) return parts.join("");
    }
    throw new LlmError(platform, "响应缺少 choices[0].message.content（reasoning 也为空）");
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

/** 三平台 LLM 客户端，fetch 直调不依赖宿主 llm 服务，system 作为单轮 system prompt 注入 */
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
      // apiKey 解析为空时请求必然失败，尽早报错避免白等网络超时
      if (config.apiKey && !apiKey) {
        throw new LlmError(config.platform, `apiKey 解析结果为空（检查 env:// 变量是否存在或 file:// 路径是否有效）`);
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
