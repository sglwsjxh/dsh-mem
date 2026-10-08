// dsh-mem 本地嵌入：onnx（transformers.js）与 gguf（node-llama-cpp）双路径统一入口
// 来源与定位由 model-resolve.ts 决定；本模块只负责加载与推理
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EmbeddingConfig, EmbeddingTask, Embedder } from "../types.js";
import { getConfig } from "../config.js";
import { downloadToCache } from "./model-downloader.js";
import {
  parseModelRef,
  resolveModelLocation,
  type ResolvedModel,
} from "./model-resolve.js";

/**
 * 内置 task 前缀（检索协议：query=检索查询，document=文档标题+正文）
 * 适用采用该 prompt 协议的嵌入模型（如 EmbeddingGemma 系）；可用 embedding.taskPrefixes 覆盖
 */
export const TASK_QUERY_PREFIX = "task: search result | query: ";
export const TASK_DOCUMENT_PREFIX = "title: none | text: ";

export function applyTaskPrefix(text: string, task: EmbeddingTask | undefined, config: EmbeddingConfig): string {
  if (!task) return text;
  const query = config.taskPrefixes?.query ?? TASK_QUERY_PREFIX;
  const document = config.taskPrefixes?.document ?? TASK_DOCUMENT_PREFIX;
  const prefix = task === "query" ? query : document;
  if (!prefix) return text;
  return `${prefix}${text}`;
}

/** MRL 截断 + L2 重归一化（截断后必须重归一化，否则排序质量静默劣化） */
export function truncateAndNormalize(vector: Float32Array, dimensions: number): Float32Array {
  if (dimensions >= vector.length) return vector;
  const sliced = vector.slice(0, dimensions);
  let sum = 0;
  for (let i = 0; i < sliced.length; i++) sum += sliced[i]! * sliced[i]!;
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < sliced.length; i++) sliced[i] = sliced[i]! / norm;
  return sliced;
}

const EMBED_TIMEOUT_MS = 30000;
const MAX_CACHE_SIZE = 100;

/** 抽象 transformers.js 最小接口，测试可注入 mock */
export interface FeatureExtractorLike {
  (text: string, options: { pooling: "mean"; normalize: boolean }): Promise<{ data: Float32Array }>;
  dispose?(): Promise<void>;
}

/** 抽象 node-llama-cpp 最小接口，测试可注入 mock */
export interface GgufEmbedderLike {
  (text: string): Promise<{ vector: readonly number[] }>;
  dispose?(): Promise<void>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`嵌入超时 (${ms}ms)`)), ms)),
  ]);
}

/** dimensions 自动探测的持久化文件 */
function metaFile(): string {
  return join(getConfig().dataPath, "meta.json");
}

function loadDimensionCache(): Record<string, number> {
  try {
    if (existsSync(metaFile())) {
      const parsed = JSON.parse(readFileSync(metaFile(), "utf-8")) as Record<string, unknown>;
      if (parsed.embeddingDimensions && typeof parsed.embeddingDimensions === "object") {
        return parsed.embeddingDimensions as Record<string, number>;
      }
    }
  } catch {
    // 损坏即重建
  }
  return {};
}

function saveDimensionCache(cache: Record<string, number>): void {
  try {
    mkdirSync(getConfig().dataPath, { recursive: true });
    const existing = existsSync(metaFile())
      ? (JSON.parse(readFileSync(metaFile(), "utf-8")) as Record<string, unknown>)
      : {};
    writeFileSync(metaFile(), JSON.stringify({ ...existing, embeddingDimensions: cache }, null, 2));
  } catch {
    // 写失败不阻塞，仅进程内生效
  }
}

/** 本地嵌入实现：按 parseModelRef + resolveModelLocation 分派 onnx / gguf */
export class LocalEmbedder implements Embedder {
  private readonly config: EmbeddingConfig;
  private readonly modelKey: string;
  private initPromise: Promise<void> | null = null;
  private _isReady = false;
  initError: string | null = null;
  private cache = new Map<string, Float32Array>();
  private extractor: FeatureExtractorLike | null = null;
  private ggufEmbed: GgufEmbedderLike | null = null;
  private runtime: "onnx" | "gguf" = "onnx";

  constructor(config: EmbeddingConfig, modelKey: string) {
    this.config = config;
    this.modelKey = modelKey;
  }

  isReady(): boolean {
    return this._isReady;
  }

  warmup(): Promise<void> {
    if (this._isReady) return Promise.resolve();
    if (this.initError) return Promise.reject(new Error(this.initError));
    if (!this.initPromise) {
      this.initPromise = this.initialize().catch((error: unknown) => {
        // fail-fast 语义：初始化失败后拒绝重试，避免"永远在初始化"
        this.initPromise = null;
        this.initError = error instanceof Error ? error.message : String(error);
        throw error;
      });
    }
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    if (!this.config.model) throw new Error("embedding.model 未配置");
    const ref = parseModelRef(this.config.model);
    if (ref.source.kind === "openai") {
      throw new Error(`embedding.model "${this.config.model}" 是远程模型名，但本地嵌入器被调用；请检查 embedding 配置`);
    }
    const resolved = await resolveModelLocation(ref, async (source) => {
      const repoId = source.kind === "hf" || source.kind === "ms" ? `${source.org}/${source.repo}` : "";
      await downloadToCache(source, repoId);
    });
    if (resolved.kind === "gguf") await this.initializeGguf(resolved);
    else await this.initializeOnnx(resolved);
    this._isReady = true;
  }

  private async initializeOnnx(resolved: ResolvedModel & { kind: "onnx" }): Promise<void> {
    if (!existsSync(join(resolved.dir, "config.json"))) {
      throw new Error(`ONNX 模型目录缺少 config.json: ${resolved.dir}`);
    }
    const { pipeline } = await import("@huggingface/transformers");
    const factory = pipeline as unknown as (
      task: "feature-extraction",
      model: string,
      opts: Record<string, unknown>
    ) => Promise<FeatureExtractorLike>;
    this.extractor = await factory("feature-extraction", resolved.dir, {
      dtype: "q8",
      device: "cpu",
      local_files_only: true,
    });
    this.runtime = "onnx";
  }

  private async initializeGguf(resolved: ResolvedModel & { kind: "gguf" }): Promise<void> {
    const { getLlama } = await import("node-llama-cpp");
    const llama = await getLlama({ build: "never" });
    const model = await llama.loadModel({ modelPath: resolved.file });
    const context = await model.createEmbeddingContext();
    this.ggufEmbed = Object.assign(
      async (text: string) => {
        const embedding = await context.getEmbeddingFor(text);
        return { vector: embedding.vector };
      },
      {
        dispose: async () => {
          await context.dispose();
          await model.dispose();
          await llama.dispose();
        },
      }
    ) as GgufEmbedderLike;
    this.runtime = "gguf";
  }

  /** 生效维度：显式配置优先，否则用自动探测缓存 */
  private effectiveDimensions(): number | undefined {
    return this.config.dimensions ?? this.autoDimensions;
  }

  private autoDimensions: number | undefined;

  async embed(text: string, task?: EmbeddingTask): Promise<Float32Array> {
    const input = applyTaskPrefix(text, task, this.config);
    const cached = this.cache.get(input);
    if (cached) return cached;
    if (!this._isReady) await this.warmup();
    let vector: Float32Array;
    if (this.runtime === "gguf") {
      if (!this.ggufEmbed) throw new Error(this.initError ?? "gguf 嵌入器未初始化");
      const result = await withTimeout(this.ggufEmbed(input), EMBED_TIMEOUT_MS);
      vector = Float32Array.from(result.vector);
    } else {
      if (!this.extractor) throw new Error(this.initError ?? "onnx 嵌入器未初始化");
      const output = await withTimeout(this.extractor(input, { pooling: "mean", normalize: true }), EMBED_TIMEOUT_MS);
      vector = new Float32Array(output.data);
    }
    // 维度守卫：显式配置时截断归一；未配置时首次探测并持久化
    const dims = this.effectiveDimensions();
    if (dims === undefined) {
      this.autoDimensions = vector.length;
      const cache = loadDimensionCache();
      cache[this.modelKey] = vector.length;
      saveDimensionCache(cache);
    } else {
      vector = truncateAndNormalize(vector, dims);
      if (vector.length < dims) {
        throw new Error(`嵌入维度 ${vector.length} 小于配置 dimensions=${dims}，请检查模型与配置是否匹配`);
      }
    }
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(input, vector);
    return vector;
  }

  async dispose(): Promise<void> {
    this.cache.clear();
    this.extractor = null;
    if (this.ggufEmbed) {
      await this.ggufEmbed.dispose?.();
      this.ggufEmbed = null;
    }
    this._isReady = false;
    this.initPromise = null;
  }
}

let localEmbedder: LocalEmbedder | null = null;
let localEmbedderKey = "";

export function getLocalEmbedder(config: EmbeddingConfig): LocalEmbedder {
  const key = config.model;
  if (!localEmbedder || localEmbedderKey !== key) {
    void localEmbedder?.dispose();
    localEmbedder = new LocalEmbedder(config, key);
    localEmbedderKey = key;
  }
  return localEmbedder;
}

export function resetLocalEmbedder(): void {
  void localEmbedder?.dispose();
  localEmbedder = null;
  localEmbedderKey = "";
}
