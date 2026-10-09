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

// 嵌入服务：只走 OpenAI 兼容 embeddings API
// 本地模型请自起 OpenAI 兼容服务并填 baseurl
import type { EmbeddingConfig, Embedder } from "../types.js";
import { resolveSecretValue } from "./secret-resolver.js";

const EMBED_TIMEOUT_MS = 30000;

/** 单例按 model 重建，config 由调用方在 initConfig 后传入 */
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

  /** warmup 只做一次真实 API 探测，失败即报错不重试 */
  async warmup(): Promise<void> {
    if (this._isReady) return;
    if (this.initError) throw new Error(this.initError);
    try {
      await this.embedText("warmup", undefined);
      this._isReady = true;
    } catch (error) {
      // 报错后拒绝重试，避免永远停在初始化
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
