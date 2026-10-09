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

// 共享类型契约，模块与测试共同依赖

// ---- 嵌入模型配置 ----

/** 嵌入模型配置，只支持远程 OpenAI 兼容端点 */
export interface EmbeddingConfig {
  /** OpenAI 兼容模型名，本地服务同样如此 */
  model: string;
  /** 端点，如 https://api.openai.com/v1 或 http://127.0.0.1:8080/v1 */
  baseUrl: string;
  /** 支持 env://NAME 与 file:///path 与明文 */
  apiKey?: string;
  /** 向量维度，配置后直接透传 API，不做本地探测与截断 */
  dimensions?: number;
}

// ---- LLM ----

export type LlmPlatform = "openai" | "anthropic" | "gemini";

/** 内部 LLM 配置，用于自动捕获与画像学习 */
export interface LlmConfig {
  platform: LlmPlatform;
  /** 端点，如 https://api.openai.com/v1 */
  baseUrl: string;
  model: string;
  /** 支持 env://NAME 与 file:///path 与明文 */
  apiKey: string;
  /** 超时毫秒 */
  timeoutMs: number;
}

// ---- 记忆 ----

/** 全量配置，dsh-mem.jsonc 归一后形态 */
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

/** 检索范围：project 仅当前项目，all 跨全部项目含 user 分片 */
export type MemoryScope = "project" | "all";

/** 一条记忆的对外形态 */
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

export interface MemorySearchResult {
  id: string;
  memory: string;
  similarity: number;
  createdAt: number;
  tags: string[];
  metadata?: Record<string, unknown>;
  containerTag: string;
}

// ---- 项目标签 ----

/** 项目身份标签，含容器标签与用户信息 */
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

// ---- 自动捕获 ----

/** LLM 产出的总结结构 */
export interface CaptureSummary {
  summary: string;
  type: MemoryType;
  tags: string[];
}

// ---- 用户画像 ----

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

// ---- 嵌入服务接口 ----

/** 嵌入服务接口，远程 OpenAI 兼容实现 */
export interface Embedder {
  /** 首次真实 API 探测。幂等，失败置 initError 后不再重试 */
  warmup(progressCallback?: (progress: unknown) => void): Promise<void>;
  /** 生成向量，API 返回值原样使用 */
  embed(text: string): Promise<Float32Array>;
  isReady(): boolean;
  /** 初始化错误，fail-fast 语义 */
  initError: string | null;
  dispose(): Promise<void>;
}

// ---- LLM 客户端接口 ----

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

/** 内部 LLM 客户端，openai 与 anthropic 与 gemini 三风格共用 */
export interface LlmClient {
  /** 单轮请求，返回 assistant 文本 */
  complete(messages: LlmMessage[], system?: string): Promise<string>;
}
