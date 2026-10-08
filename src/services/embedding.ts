// dsh-mem 嵌入门面：按 model 字符串来源分派 openai / 本地实现，全局单例
import type { Embedder, EmbeddingTask } from "../types.js";
import { getConfig } from "../config.js";
import { getLocalEmbedder, resetLocalEmbedder } from "./embedding-local.js";
import { OpenAiEmbedder } from "./embedding-openai.js";
import { parseModelRef } from "./model-resolve.js";

/**
 * 嵌入服务门面。warmup/embed 语义遵循 src/types.ts 的 Embedder 契约：
 * - warmup 幂等，失败置 initError 后 fail-fast（拒绝无限重试）
 * - embed 返回已归一化的 Float32Array
 * - task 前缀在实现层统一注入
 */
export class EmbeddingService implements Embedder {
  private backend: Embedder;
  /** 单例缓存键：当前实例对应的配置签名 */
  configKey = "";

  private constructor(backend: Embedder) {
    this.backend = backend;
  }

  /** 按当前配置构造（配置变化时返回新实例） */
  static create(): EmbeddingService {
    const cfg = getConfig();
    const ref = parseModelRef(cfg.embedding.model);
    if (ref.source.kind === "openai") {
      return new EmbeddingService(new OpenAiEmbedder(cfg.embedding, ref.raw));
    }
    return new EmbeddingService(getLocalEmbedder(cfg.embedding));
  }

  isReady(): boolean {
    return this.backend.isReady();
  }

  get initError(): string | null {
    return this.backend.initError;
  }

  warmup(progressCallback?: (progress: unknown) => void): Promise<void> {
    void progressCallback;
    return this.backend.warmup();
  }

  embed(text: string, task?: EmbeddingTask): Promise<Float32Array> {
    return this.backend.embed(text, task);
  }

  async dispose(): Promise<void> {
    await this.backend.dispose();
  }
}

let service: EmbeddingService | null = null;

/** 全局嵌入单例；配置键变化时自动重建 */
export function getEmbeddingService(): EmbeddingService {
  const cfg = getConfig();
  const key = `${cfg.embedding.model}|${cfg.embedding.baseUrl ?? ""}|${cfg.embedding.apiKey ?? ""}|${cfg.embedding.dimensions ?? ""}`;
  if (!service || service.configKey !== key) {
    void service?.dispose();
    resetLocalEmbedder();
    service = EmbeddingService.create();
    service.configKey = key;
  }
  return service;
}

/** 测试用：重置全局单例 */
export function resetEmbeddingService(): void {
  void service?.dispose();
  service = null;
  resetLocalEmbedder();
}
