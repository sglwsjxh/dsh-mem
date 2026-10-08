// dsh-mem 配置：加载 config.jsonc（工作区优先）或 ~/.dsh/dsh-mem.jsonc
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./services/jsonc.js";
import { resolveSecretValue } from "./services/secret-resolver.js";
import type { EmbeddingConfig, LlmConfig, MemoryScope } from "./types.js";

export const DATA_DIR = resolve(process.cwd(), "data");
const WORKSPACE_CONFIG = "config.jsonc";
const HOME_CONFIG_DIR = join(homedir(), ".dsh");
const HOME_CONFIG_FILES = [join(HOME_CONFIG_DIR, "dsh-mem.jsonc"), join(HOME_CONFIG_DIR, "dsh-mem.json")];

/** 插件包自身目录（config.jsonc 放在插件根时的定位依据） */
function packageRoot(): string | null {
  try {
    // lib/dist 产物位于包根下一层
    return resolve(dirname(fileURLToPath(import.meta.url)), "..");
  } catch {
    return null;
  }
}

/** 嵌入模型配置（config.jsonc 的 embedding 段） */
export interface EmbeddingSection {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  dimensions?: number;
  taskPrefixes?: {
    query?: string;
    document?: string;
  };
}

/** 内部 LLM 配置 */
export interface LlmSection {
  platform: "openai" | "anthropic" | "gemini";
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}

/** dsh-mem 顶层配置（解析后的生效形态） */
export interface DshMemConfig {
  /** 向量数据目录，默认 ./data */
  dataPath: string;
  /** 嵌入模型配置 */
  embedding: EmbeddingSection;
  /** 内部 LLM 配置（自动捕获/画像学习） */
  llm: LlmSection;
  /** 自动捕获 */
  autoCaptureEnabled: boolean;
  autoCaptureMaxRetries: number;
  /** 上下文预算（字节） */
  autoCaptureMaxContext: number;
  /** 总结语言：auto 自动检测，或 ISO 639-1 码 */
  autoCaptureLanguage: string;
  /** 记忆 */
  similarityThreshold: number;
  maxMemories: number;
  /** project 仅当前项目；all 跨全部项目 */
  memoryDefaultScope: MemoryScope;
  /** 去重 */
  deduplicationEnabled: boolean;
  deduplicationSimilarityThreshold: number;
  /** 清理 */
  autoCleanupEnabled: boolean;
  autoCleanupRetentionDays: number;
  /** 每分片最大向量数 */
  maxVectorsPerShard: number;
  /** 注入 */
  injectEnabled: boolean;
  injectMaxMemories: number;
  injectExcludeCurrentSession: boolean;
  injectMaxAgeDays?: number;
  injectProfile: boolean;
  /** 画像 */
  userProfileEnabled: boolean;
  userProfileAnalysisInterval: number;
  userProfileMaxContext: number;
  userProfileStaleDays: number;
  /** 加密 */
  databaseEncryptionEnabled: boolean;
  databaseEncryptionKey?: string;
}

const DEFAULT_EMBEDDING: EmbeddingSection = {
  model: "",
};

const DEFAULT_LLM: LlmSection = {
  platform: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "",
  apiKey: "",
  timeoutMs: 90000,
};

function defaultConfig(): DshMemConfig {
  return {
    dataPath: DATA_DIR,
    embedding: { ...DEFAULT_EMBEDDING },
    llm: { ...DEFAULT_LLM },
    autoCaptureEnabled: true,
    autoCaptureMaxRetries: 3,
    autoCaptureMaxContext: 131072,
    autoCaptureLanguage: "auto",
    similarityThreshold: 0.8,
    maxMemories: 10,
    memoryDefaultScope: "project",
    deduplicationEnabled: true,
    deduplicationSimilarityThreshold: 0.9,
    autoCleanupEnabled: true,
    autoCleanupRetentionDays: 30,
    maxVectorsPerShard: 50000,
    injectEnabled: true,
    injectMaxMemories: 3,
    injectExcludeCurrentSession: true,
    injectProfile: true,
    userProfileEnabled: true,
    userProfileAnalysisInterval: 10,
    userProfileMaxContext: 32768,
    userProfileStaleDays: 2,
    databaseEncryptionEnabled: false,
  };
}

/** 命中的配置文件路径与其所在目录（相对路径 datapath 的解析基准） */
interface LoadedConfig {
  raw: Partial<DshMemConfig>;
  baseDir: string;
}

function loadConfigFromPaths(paths: string[]): LoadedConfig | undefined {
  for (const path of paths) {
    if (existsSync(path)) {
      try {
        return {
          raw: parseJsonc<Record<string, unknown>>(readFileSync(path, "utf-8")) as Partial<DshMemConfig>,
          baseDir: dirname(path),
        };
      } catch {
        // 忽略无法解析的配置
      }
    }
  }
  return undefined;
}

/**
 * 顶层 key 大小写归一：config.jsonc 里 datapath/DataPath 皆可
 * 归一规则：小写；embedding/llm 子段保持原样（内部单独归一）
 */
function normalizeTopKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const lower = key.toLowerCase();
    const canonical = KEY_ALIASES[lower] ?? lower;
    out[canonical] = value;
  }
  return out;
}

/** 小写别名 → 规范字段名 */
const KEY_ALIASES: Record<string, string> = {
  datapath: "dataPath",
  autocaptureenabled: "autoCaptureEnabled",
  autocapturemaxretries: "autoCaptureMaxRetries",
  autocapturemaxcontext: "autoCaptureMaxContext",
  autocapturelanguage: "autoCaptureLanguage",
  autocapturemaxcontextbytes: "autoCaptureMaxContext",
  similaritythreshold: "similarityThreshold",
  maxmemories: "maxMemories",
  memorydefaultscope: "memoryDefaultScope",
  deduplicationenabled: "deduplicationEnabled",
  deduplicationsimilaritythreshold: "deduplicationSimilarityThreshold",
  autocleanupenabled: "autoCleanupEnabled",
  autocleanupretentiondays: "autoCleanupRetentionDays",
  maxvectorspershard: "maxVectorsPerShard",
  injectenabled: "injectEnabled",
  injectmaxmemories: "injectMaxMemories",
  injectexcludecurrentsession: "injectExcludeCurrentSession",
  injectmaxagedays: "injectMaxAgeDays",
  injectprofile: "injectProfile",
  userprofileenabled: "userProfileEnabled",
  userprofileanalysisinterval: "userProfileAnalysisInterval",
  userprofilemaxcontext: "userProfileMaxContext",
  userprofilemaxcontextbytes: "userProfileMaxContext",
  userprofilestaledays: "userProfileStaleDays",
  databaseencryptionenabled: "databaseEncryptionEnabled",
  databaseencryptionkey: "databaseEncryptionKey",
};

/** scope 旧值 → 新值（0.1.0 的 all-projects → all） */
function normalizeScope(value: unknown): MemoryScope | undefined {
  if (value === "project") return "project";
  if (value === "all" || value === "all-projects") return "all";
  return undefined;
}

/** 解析后的生效配置 */
let CONFIG: DshMemConfig | undefined;

/**
 * 加载配置（幂等）；workspaceRoot 为 dsh 工作区目录。
 * 查找顺序：
 * 1. 显式 workspaceRoot/config.jsonc
 * 2. 环境变量 DSH_MEM_WORKSPACE/config.jsonc
 * 3. 进程 cwd 逐级向上找 config.jsonc（cordis 不传 workspaceRoot 时的兜底）
 * 4. ~/.dsh/dsh-mem.jsonc
 */
export function initConfig(workspaceRoot?: string): DshMemConfig {
  if (CONFIG) return CONFIG;

  const paths: string[] = [];
  if (workspaceRoot) paths.push(join(resolve(workspaceRoot), WORKSPACE_CONFIG));
  if (process.env.DSH_MEM_WORKSPACE) {
    paths.push(join(resolve(process.env.DSH_MEM_WORKSPACE), WORKSPACE_CONFIG));
  }
  // DSH_MEM_CONFIG_ISOLATED=1 时只认显式路径（测试隔离用）
  const isolated = process.env.DSH_MEM_CONFIG_ISOLATED === "1";
  if (!isolated) {
    // 从 cwd 向上逐级探测（覆盖宿主在子目录启动的情况）
    let probe = resolve(process.cwd());
    for (let depth = 0; depth < 8; depth++) {
      paths.push(join(probe, WORKSPACE_CONFIG));
      const parent = resolve(probe, "..");
      if (parent === probe) break;
      probe = parent;
    }
    // 插件包根目录（config.jsonc 与插件同目录时的兜底）
    const pkgRoot = packageRoot();
    if (pkgRoot) paths.push(join(pkgRoot, WORKSPACE_CONFIG));
  }
  paths.push(...HOME_CONFIG_FILES);

  const loaded = loadConfigFromPaths(paths);
  const raw = normalizeTopKeys((loaded?.raw ?? {}) as Record<string, unknown>);
  const cfg = defaultConfig();

  // datapath 相对路径以命中的配置文件所在目录为基准
  if (raw.dataPath !== undefined) {
    const base = loaded?.baseDir ?? process.cwd();
    cfg.dataPath = resolve(base, String(raw.dataPath));
  }

  const rawEmbedding = raw.embedding as Record<string, unknown> | undefined;
  if (rawEmbedding) {
    const emb: EmbeddingSection = { ...cfg.embedding };
    if (typeof rawEmbedding.model === "string") emb.model = rawEmbedding.model;
    if (typeof rawEmbedding.baseurl === "string") emb.baseUrl = rawEmbedding.baseurl;
    if (typeof rawEmbedding.baseUrl === "string") emb.baseUrl = rawEmbedding.baseUrl;
    if (typeof rawEmbedding.apikey === "string") emb.apiKey = rawEmbedding.apikey;
    if (typeof rawEmbedding.apiKey === "string") emb.apiKey = rawEmbedding.apiKey;
    if (typeof rawEmbedding.dimensions === "number") emb.dimensions = rawEmbedding.dimensions;
    if (rawEmbedding.taskPrefixes && typeof rawEmbedding.taskPrefixes === "object") {
      const tp = rawEmbedding.taskPrefixes as Record<string, unknown>;
      emb.taskPrefixes = {
        ...(typeof tp.query === "string" ? { query: tp.query } : {}),
        ...(typeof tp.document === "string" ? { document: tp.document } : {}),
      };
    }
    cfg.embedding = emb;
  }

  const rawLlm = raw.llm as Record<string, unknown> | undefined;
  if (rawLlm) {
    const llm: LlmSection = { ...cfg.llm };
    if (rawLlm.platform === "openai" || rawLlm.platform === "anthropic" || rawLlm.platform === "gemini") llm.platform = rawLlm.platform;
    if (typeof rawLlm.baseUrl === "string") llm.baseUrl = rawLlm.baseUrl;
    if (typeof rawLlm.model === "string") llm.model = rawLlm.model;
    if (typeof rawLlm.apiKey === "string") llm.apiKey = rawLlm.apiKey;
    if (typeof rawLlm.apikey === "string") llm.apiKey = rawLlm.apikey;
    if (typeof rawLlm.timeoutMs === "number") llm.timeoutMs = rawLlm.timeoutMs;
    cfg.llm = llm;
  }

  for (const key of [
    "autoCaptureEnabled",
    "autoCaptureMaxRetries",
    "autoCaptureMaxContext",
    "autoCaptureLanguage",
    "similarityThreshold",
    "maxMemories",
    "deduplicationEnabled",
    "deduplicationSimilarityThreshold",
    "autoCleanupEnabled",
    "autoCleanupRetentionDays",
    "maxVectorsPerShard",
    "injectEnabled",
    "injectMaxMemories",
    "injectExcludeCurrentSession",
    "injectMaxAgeDays",
    "injectProfile",
    "userProfileEnabled",
    "userProfileAnalysisInterval",
    "userProfileMaxContext",
    "userProfileStaleDays",
    "databaseEncryptionEnabled",
    "databaseEncryptionKey",
  ] as const) {
    if (raw[key] !== undefined) {
      (cfg as unknown as Record<string, unknown>)[key] = raw[key];
    }
  }

  const scope = normalizeScope(raw.memoryDefaultScope);
  if (scope) cfg.memoryDefaultScope = scope;

  // data 目录必须存在
  if (!existsSync(cfg.dataPath)) {
    mkdirSync(cfg.dataPath, { recursive: true });
  }

  CONFIG = cfg;
  return cfg;
}

/** 取当前配置（未初始化则抛错） */
export function getConfig(): DshMemConfig {
  if (!CONFIG) throw new Error("dsh-mem config not initialized; call initConfig() first");
  return CONFIG;
}

/** 测试与重载用 */
export function resetConfig(): void {
  CONFIG = undefined;
}

/** 解析 LLM apiKey（支持 env:// 与 file://） */
export function resolveLlmApiKey(cfg: DshMemConfig): string | undefined {
  return resolveSecretValue(cfg.llm.apiKey);
}

/** 解析嵌入 apiKey（远程来源用） */
export function resolveEmbeddingApiKey(cfg: DshMemConfig): string | undefined {
  return resolveSecretValue(cfg.embedding.apiKey);
}

export function isConfigured(): boolean {
  if (!CONFIG) return false;
  return CONFIG.llm.model !== "" || CONFIG.embedding.model !== "";
}
