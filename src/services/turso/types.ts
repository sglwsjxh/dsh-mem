// 存储层内部类型：分片注册信息与向量写入记录

export interface ShardInfo {
  id: number;
  scope: "user" | "project";
  scopeHash: string;
  shardIndex: number;
  dbPath: string;
  vectorCount: number;
  isActive: boolean;
  createdAt: number;
}

/** 向量层写入记录，区别于对外 src/types.ts 的 MemoryRecord */
export interface StoredMemory {
  id: string;
  content: string;
  vector: Float32Array;
  tagsVector?: Float32Array;
  containerTag: string;
  /** 逗号拼接的标签串 */
  tags?: string;
  type?: string;
  createdAt: number;
  updatedAt: number;
  /** JSON 序列化的动态元数据 */
  metadata?: string;
  /** 会话 id，同时镜像在 metadata.sessionID */
  sessionId?: string;
  displayName?: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
}
