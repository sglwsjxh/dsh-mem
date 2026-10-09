// dsh-mem 共享类型契约：所有模块与测试共同依赖的接口

// ============ 嵌入模型配置 ============

/** 嵌入模型配置（config.jsonc 的 embedding 段）；只支持远程 OpenAI 兼容端点 */
export interface EmbeddingConfig {
  /** 模型名（openai 兼容；llama.cpp server 等本地服务也用 OpenAI 兼容模型名） */
  model: string;
  /** 端点，如 https://api.openai.com/v1 或 http://127.0.0.1:8080/v1 */
  baseUrl: string;
  /** API Key，支持 env://NAME / file:///path / 明文 */
  apiKey?: string;
  /** 向量维度；配置了就直接透传给 API，不做本地探测与截断 */
  dimensions?: number;
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

/** 全量配置（~/.dsh/dsh-mem.jsonc 归一后的形态） */
export interface DshMemConfig {
  dataPath: string;
  embedding: EmbeddingConfig;
  llm: LlmConfig;
  autoCaptureEnabled: boolean;
  autoCaptureMaxRetries: number;
  autoCaptureMaxContext: number;
  similarityThreshold: number;
  maxMemories: number;
  memoryDefaultScope: MemoryScope;
  deduplicationEnabled: boolean;
  deduplicationSimilarityThreshold: number;
  autoCleanupEnabled: boolean;
  autoCleanupRetentionDays: number;
  maxVectorsPerShard: number;
  injectEnabled: boolean;
  injectMaxMemories: number;
  injectExcludeCurrentSession: boolean;
  injectMaxAgeDays?: number;
  injectProfile: boolean;
  userProfileEnabled: boolean;
  userProfileAnalysisInterval: number;
  userProfileMaxContext: number;
  userProfileStaleDays: number;
}

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

/** Embedder 接口：远程 OpenAI 兼容实现 */
export interface Embedder {
  /** 首次真实 API 探测；幂等，失败置 initError 后拒绝重试 */
  warmup(progressCallback?: (progress: unknown) => void): Promise<void>;
  /** 生成向量（API 返回的向量原样使用） */
  embed(text: string): Promise<Float32Array>;
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
