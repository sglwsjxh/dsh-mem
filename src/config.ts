// 配置加载：只读 ~/.dsh/dsh-mem.jsonc，缺失或不可解析时 stderr 报错并跳过装配
// 刻意不做多路径探测——找得到就读，找不到就报错，方便排查
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { DshMemConfig } from "./types.js";
import { parseJsonc } from "./services/jsonc.js";

/** 配置唯一路径：~/.dsh/dsh-mem.jsonc */
export const CONFIG_PATH = join(homedir(), ".dsh", "dsh-mem.jsonc");

let config: DshMemConfig | null = null;

/** 大小写归一：顶层 key 转小写查别名表 */
const KEY_ALIASES: Record<string, string> = {
  datapath: "dataPath",
  baseurl: "baseUrl",
  apikey: "apiKey",
  autocaptureenabled: "autoCaptureEnabled",
  autocapturemaxretries: "autoCaptureMaxRetries",
  autocapturemaxcontext: "autoCaptureMaxContext",
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
  userprofilestaledays: "userProfileStaleDays",
};

/** 宽松读取嵌套配置段：baseurl/baseUrl、apikey/apiKey 双拼写等价 */
function readSection(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = k.toLowerCase() === "baseurl" ? "baseUrl" : k.toLowerCase() === "apikey" ? "apiKey" : k;
    out[key] = v;
  }
  return out;
}

/** 用默认值填充，显式配置覆盖；类型不符的键直接忽略（不猜不救） */
function normalize(raw: Record<string, unknown>): DshMemConfig {
  const embedding = readSection(raw.embedding);
  const llm = readSection(raw.llm);
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

  const rawScope = str(llm.memoryDefaultScope) ?? str(raw.memoryDefaultScope);
  const scope = rawScope === "all" ? "all" : "project";

  // datapath 相对 ~/.dsh/ 解析
  const rawPath = str(raw.datapath) ?? "./data";
  const dataPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(join(homedir(), ".dsh"), rawPath);

  return {
    dataPath,
    embedding: {
      model: str(embedding.model) ?? "",
      baseUrl: str(embedding.baseUrl) ?? "",
      apiKey: str(embedding.apiKey) ?? "",
      dimensions: num(embedding.dimensions),
    },
    llm: {
      platform: llm.platform === "anthropic" || llm.platform === "gemini" ? llm.platform : "openai",
      baseUrl: str(llm.baseUrl) ?? "",
      model: str(llm.model) ?? "",
      apiKey: str(llm.apiKey) ?? "",
      timeoutMs: num(llm.timeoutMs) ?? 90000,
    },
    autoCaptureEnabled: bool(raw.autoCaptureEnabled) ?? true,
    autoCaptureMaxRetries: num(raw.autoCaptureMaxRetries) ?? 3,
    autoCaptureMaxContext: num(raw.autoCaptureMaxContext) ?? 131072,
    similarityThreshold: num(raw.similarityThreshold) ?? 0.5,
    maxMemories: num(raw.maxMemories) ?? 10,
    memoryDefaultScope: scope,
    deduplicationEnabled: bool(raw.deduplicationEnabled) ?? true,
    deduplicationSimilarityThreshold: num(raw.deduplicationSimilarityThreshold) ?? 0.85,
    autoCleanupEnabled: bool(raw.autoCleanupEnabled) ?? true,
    autoCleanupRetentionDays: num(raw.autoCleanupRetentionDays) ?? 30,
    maxVectorsPerShard: num(raw.maxVectorsPerShard) ?? 50000,
    injectEnabled: bool(raw.injectEnabled) ?? true,
    injectMaxMemories: num(raw.injectMaxMemories) ?? 3,
    injectExcludeCurrentSession: bool(raw.injectExcludeCurrentSession) ?? true,
    injectMaxAgeDays: num(raw.injectMaxAgeDays),
    injectProfile: bool(raw.injectProfile) ?? true,
    userProfileEnabled: bool(raw.userProfileEnabled) ?? true,
    userProfileAnalysisInterval: num(raw.userProfileAnalysisInterval) ?? 10,
    userProfileMaxContext: num(raw.userProfileMaxContext) ?? 32768,
    userProfileStaleDays: num(raw.userProfileStaleDays) ?? 2,
  };
}

/** 未初始化时调用 getConfig 直接报错——fail-fast，不给默认配置兜底 */
export function initConfig(): DshMemConfig | null {
  if (config) return config;
  if (!existsSync(CONFIG_PATH)) {
    console.error(`[dsh-mem] 配置文件不存在: ${CONFIG_PATH}\n[dsh-mem] 请复制 config.jsonc.example 到该位置并填写 embedding.model 与 llm.model`);
    return null;
  }
  try {
    const raw = parseJsonc(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
    config = normalize(raw);
    if (!config.embedding.model || !config.embedding.baseUrl) {
      console.error(`[dsh-mem] 配置不完整: embedding.model 与 embedding.baseurl 必填 (${CONFIG_PATH})`);
      config = null;
      return null;
    }
    // dataPath 目录缺失时创建——这是一次性引导而非探测
    if (!existsSync(config.dataPath)) mkdirSync(config.dataPath, { recursive: true });
    return config;
  } catch (error) {
    console.error(`[dsh-mem] 配置解析失败: ${CONFIG_PATH} (${error instanceof Error ? error.message : String(error)})`);
    config = null;
    return null;
  }
}

export function getConfig(): DshMemConfig {
  if (!config) throw new Error("dsh-mem config not initialized; initConfig() failed or was not called");
  return config;
}

export function isConfigured(): boolean {
  return config !== null;
}

export function resetConfig(): void {
  config = null;
}
