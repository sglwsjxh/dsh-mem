// 嵌入服务：只走 OpenAI 兼容 /embeddings API，无本地推理、无模型下载、无缓存探测
// 本地模型（GGUF/llama.cpp server、ONNX）请自行起 OpenAI 兼容服务并填 baseurl
import type { EmbeddingConfig, Embedder } from "../types.js";
import { resolveSecretValue } from "./secret-resolver.js";

const EMBED_TIMEOUT_MS = 30000;

/** 单例：按 model 字符串重建；config 由调用方（plugin-entry）在 initConfig 成功后传入 */
let service: EmbeddingService | null = null;
let serviceKey = "";

export function getEmbeddingService(config: EmbeddingConfig): EmbeddingService {
  const key = config.model;
  if (!service || serviceKey !== key) {
    void service?.dispose();
    service = new EmbeddingService(config);
    serviceKey = key;
  }
  return service;
}

export function resetEmbeddingService(): void {
  void service?.dispose();
  service = null;
  serviceKey = "";
}

export class EmbeddingService implements Embedder {
  private readonly config: EmbeddingConfig;
  private _isReady = false;
  initError: string | null = null;
  private cache = new Map<string, Float32Array>();
  private static readonly MAX_CACHE_SIZE = 100;

  constructor(config: EmbeddingConfig) {
    this.config = config;
  }

  isReady(): boolean {
    return this._isReady;
  }

  get initErrorOrNull(): string | null {
    return this.initError;
  }

  /** 无本地加载，warmup 只做一次真实 API 探测：失败即报错，不重试不回退 */
  async warmup(): Promise<void> {
    if (this._isReady) return;
    if (this.initError) throw new Error(this.initError);
    try {
      await this.embedText("warmup", undefined);
      this._isReady = true;
    } catch (error) {
      // fail-fast：报错后拒绝重试，避免"永远在初始化"
      this.initError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async embed(text: string): Promise<Float32Array> {
    if (this.initError) throw new Error(this.initError);
    const cached = this.cache.get(text);
    if (cached) return cached;
    const vector = await this.embedText(text, this.config.dimensions);
    if (this.cache.size >= EmbeddingService.MAX_CACHE_SIZE) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(text, vector);
    return vector;
  }

  private async embedText(text: string, dimensions?: number): Promise<Float32Array> {
    const apiKey = this.config.apiKey ? resolveSecretValue(this.config.apiKey) : "";
    if (this.config.apiKey && !apiKey) {
      throw new Error("embedding.apikey 解析结果为空（检查 env:// 变量是否存在或 file:// 路径是否有效）");
    }
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const response = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.config.model, input: [text], ...(dimensions ? { dimensions } : {}) }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => response.statusText);
      throw new Error(`embedding API HTTP ${response.status}: ${body.slice(0, 500)}`);
    }
    const data = (await response.json()) as { data?: Array<{ embedding?: unknown }> };
    const arr = data.data?.[0]?.embedding;
    if (!Array.isArray(arr) || arr.length === 0 || !arr.every((n) => typeof n === "number")) {
      throw new Error("embedding API 响应缺少 data[0].embedding 数字数组");
    }
    return new Float32Array(arr as number[]);
  }

  async dispose(): Promise<void> {
    this.cache.clear();
    this._isReady = false;
  }
}
