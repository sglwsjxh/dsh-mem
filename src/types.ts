// dsh-mem 共享类型契约：所有模块与测试共同依赖的接口

// ============ 嵌入模型配置 ============

/** 嵌入模型来源（由 embedding.model 字符串解析得出） */
export type ModelSource =
  | { kind: "openai" }
  | { kind: "file"; path: string }
  | { kind: "hf"; org: string; repo: string }
  | { kind: "ms"; org: string; repo: string };

/** model 字符串解析结果 */
export interface ParsedModelRef {
  source: ModelSource;
  /** 原始字符串 */
  raw: string;
}

/** 嵌入模型配置（config.jsonc 的 embedding 段） */
export interface EmbeddingConfig {
  /** 模型标识：openai 兼容模型名 / file://<path> / hf://<org>/<repo> / ms://<org>/<repo> */
  model: string;
  /** 远程模型端点（仅远程来源使用） */
  baseUrl?: string;
  /** 远程模型 API Key，支持 env://NAME / file:///path / 明文 */
  apiKey?: string;
  /** 向量维度；不填则首次 embed 后自动探测并持久化 */
  dimensions?: number;
  /** task 前缀覆盖（默认内置 EG2 检索协议前缀） */
  taskPrefixes?: {
    query?: string;
    document?: string;
  };
  /** 内部字段：自动探测后的实际维度（运行期缓存，不进配置文件） */
  resolvedDimensions?: number;
}

// ============ LLM ============

/** LLM 平台风格 */
export type LlmPlatform = "openai" | "anthropic" | "gemini";

/** 内部 LLM（自动捕获/画像学习）配置 */
export interface LlmConfig {
  /** openai | anthropic | gemini 三种 API 风格 */
  platform: LlmPlatform;
  /** 端点，如 https://api.openai.com/v1 */
  baseUrl: string;
  /** 模型名 */
  model: string;
  /** API Key，支持 env://NAME / file:///path / 明文 */
  apiKey: string;
  /** 请求超时毫秒 */
  timeoutMs: number;
}

// ============ 记忆 ============

export type MemoryType = string;

/** 记忆检索范围：project 仅当前项目，all 跨全部项目（含 user 分片） */
export type MemoryScope = "project" | "all";

/** 一条记忆（对外形态） */
export interface MemoryRecord {
  id: string;
  content: string;
  containerTag: string;
  tags: string[];
  type?: MemoryType;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
  isPinned?: boolean;
}

/** 搜索结果条目 */
export interface MemorySearchResult {
  id: string;
  memory: string;
  similarity: number;
  createdAt: number;
  tags: string[];
  metadata?: Record<string, unknown>;
  containerTag: string;
}

// ============ 项目标签 ============

/** 项目身份标签（容器标签 + 用户信息） */
export interface ProjectTags {
  project: {
    tag: string;
    displayName: string;
    projectPath: string;
    projectName: string;
    gitRepoUrl?: string;
  };
  user: {
    tag: string;
    displayName?: string;
    userName?: string;
    userEmail?: string;
  };
}

// ============ 自动捕获 ============

/** LLM 产出的总结结构 */
export interface CaptureSummary {
  summary: string;
  type: MemoryType;
  tags: string[];
}

// ============ 用户画像 ============

export interface ProfilePreference {
  category: string;
  description: string;
  confidence: number;
  frequency: number;
  evidence: string[];
  lastSeen: number;
}

export interface ProfilePattern {
  category: string;
  description: string;
  confidence: number;
  frequency: number;
  evidence: string[];
  lastSeen: number;
}

export interface ProfileWorkflow {
  category: string;
  description: string;
  confidence: number;
  frequency: number;
  evidence: string[];
  lastSeen: number;
}

export interface UserProfileData {
  preferences: ProfilePreference[];
  patterns: ProfilePattern[];
  workflows: ProfileWorkflow[];
}

/** 用户画像记录 */
export interface UserProfileRecord {
  id: string;
  userId: string;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  profileData: string;
  version: number;
  lastAnalyzedAt: number;
  createdAt: number;
  updatedAt: number;
}

// ============ 嵌入服务接口 ============

export type EmbeddingTask = "document" | "query";

/** Embedder 接口：onnx/gguf/openai 实现共用 */
export interface Embedder {
  /** 初始化（下载/加载模型）；幂等 */
  warmup(progressCallback?: (progress: unknown) => void): Promise<void>;
  /** 生成向量（已归一化） */
  embed(text: string, task?: EmbeddingTask): Promise<Float32Array>;
  /** 是否就绪 */
  isReady(): boolean;
  /** 初始化错误（fail-fast 语义） */
  initError: string | null;
  /** 释放资源 */
  dispose(): Promise<void>;
}

// ============ LLM 客户端接口 ============

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

/** 内部 LLM 客户端：openai/anthropic/gemini 三风格实现共用 */
export interface LlmClient {
  /** 单轮请求，返回 assistant 文本 */
  complete(messages: LlmMessage[], system?: string): Promise<string>;
}
