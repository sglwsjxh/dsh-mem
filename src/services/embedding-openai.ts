// dsh-mem OpenAI 兼容嵌入：POST {baseUrl}/embeddings，Bearer 认证
// 合法请求体仅 input/model/dimensions/encoding_format（embeddings 无 max_tokens）
import type { EmbeddingConfig, EmbeddingTask, Embedder } from "../types.js";
import { resolveSecretValue } from "./secret-resolver.js";
import { applyTaskPrefix, truncateAndNormalize } from "./embedding-local.js";

const EMBED_TIMEOUT_MS = 30000;

interface EmbeddingsResponseLike {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}

/** openai 请求体构造（导出供测试） */
export function buildEmbeddingsRequest(config: EmbeddingConfig, modelId: string, input: string, apiKey: string | undefined, baseUrl: string): { url: string; headers: Record<string, string>; body: unknown } {
  const base = (baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  return {
    url: `${base}/embeddings`,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: {
      input,
      model: modelId,
      // 显式声明返回 float 数组（部分网关默认 base64）
      encoding_format: "float",
    },
  };
}

/** OpenAI 兼容 /embeddings 实现；model/baseUrl/apiKey 均来自 embedding 段 */
export class OpenAiEmbedder implements Embedder {
  private readonly config: EmbeddingConfig;
  private readonly modelId: string;
  private readonly baseUrl: string;
  initError: string | null = null;
  private _isReady = false;

  constructor(config: EmbeddingConfig, modelId: string) {
    this.config = config;
    this.modelId = modelId;
    this.baseUrl = config.baseUrl ?? "";
  }

  isReady(): boolean {
    return this._isReady;
  }

  async warmup(): Promise<void> {
    if (this._isReady) return;
    if (this.initError) throw new Error(this.initError);
    if (!this.baseUrl) {
      this.initError = "远程嵌入模型需要配置 embedding.baseurl";
      throw new Error(this.initError);
    }
    // 发一个最小探测请求验证端点可用（fail-fast 语义）
    let apiKey: string | undefined;
    try {
      apiKey = resolveSecretValue(this.config.apiKey);
    } catch (error) {
      const message = `embedding.apiKey 解析失败: ${error instanceof Error ? error.message : String(error)}`;
      this.initError = message;
      throw new Error(message, { cause: error });
    }
    const { url, headers, body } = buildEmbeddingsRequest(this.config, this.modelId, "ping", apiKey, this.baseUrl);
    let response: EmbeddingsResponseLike;
    try {
      response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(EMBED_TIMEOUT_MS) });
    } catch (error) {
      this.initError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    if (!response.ok) {
      this.initError = `嵌入 API 健康检查失败: HTTP ${response.status}`;
      throw new Error(this.initError);
    }
    this._isReady = true;
  }

  async embed(text: string, task?: EmbeddingTask): Promise<Float32Array> {
    if (!this._isReady) await this.warmup();
    const apiKey = resolveSecretValue(this.config.apiKey);
    const input = applyTaskPrefix(text, task, this.config);
    const { url, headers, body } = buildEmbeddingsRequest(this.config, this.modelId, input, apiKey, this.baseUrl);
    let response: EmbeddingsResponseLike;
    try {
      response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(EMBED_TIMEOUT_MS) });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (!response.ok) throw new Error(`嵌入 API 请求失败: HTTP ${response.status}`);
    const data = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = data.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) throw new Error("嵌入 API 响应缺少 data[0].embedding");
    let vector: Float32Array = Float32Array.from(embedding);
    const dims = this.config.dimensions;
    if (dims !== undefined) {
      vector = truncateAndNormalize(vector, dims);
      if (vector.length < dims) {
        throw new Error(`嵌入维度 ${vector.length} 小于配置 dimensions=${dims}，请检查 embedding.model 与配置是否匹配`);
      }
    }
    return vector;
  }

  async dispose(): Promise<void> {
    this._isReady = false;
  }
}
