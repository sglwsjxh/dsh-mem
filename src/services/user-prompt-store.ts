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

// user-prompt 持久化：独立 SQLite，claim 与 capture_attempts 语义
import { connect, type Database } from "@tursodatabase/database";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfig } from "../config.js";
import { log } from "./logger.js";

const USER_PROMPTS_DB_NAME = "user-prompts.db";

/** captured: 0 待捕获 1 已捕获 2 进行中，进程内或跨进程 claim */
export interface UserPrompt {
  id: string;
  sessionId: string;
  messageId: string;
  projectPath: string | null;
  content: string;
  createdAt: number;
  captured: number;
  userLearningCaptured: boolean;
  linkedMemoryId: string | null;
  captureAttempts: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_prompts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  project_path TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  captured INTEGER NOT NULL DEFAULT 0,
  user_learning_captured INTEGER NOT NULL DEFAULT 0,
  linked_memory_id TEXT,
  capture_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts (session_id, captured);
CREATE INDEX IF NOT EXISTS idx_user_prompts_learning ON user_prompts (user_learning_captured, created_at);
`;

function newId(): string {
  return `prompt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function rowToPrompt(row: Record<string, unknown>): UserPrompt {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    messageId: String(row.message_id),
    projectPath: row.project_path ? String(row.project_path) : null,
    content: String(row.content),
    createdAt: Number(row.created_at),
    captured: Number(row.captured),
    userLearningCaptured: Number(row.user_learning_captured) === 1,
    linkedMemoryId: row.linked_memory_id ? String(row.linked_memory_id) : null,
    captureAttempts: Number(row.capture_attempts ?? 0),
  };
}

export class UserPromptStore {
  private db: Database | null = null;
  private initPromise: Promise<void> | null = null;
  /** 显式数据目录，测试注入用；未传则首次使用时按生效配置解析 */
  private readonly explicitDataPath?: string;
  private dbPath: string | null = null;

  constructor(dataPath?: string) {
    this.explicitDataPath = dataPath;
  }

  /**
   * 延迟解析 dbPath：模块级单例在 import 时构造，那时 initConfig 还没跑，
   * 构造期取 dataPath 会绑到进程 cwd，宿主从别处启动就写错地方且静默失败
   */
  private resolveDbPath(): string {
    if (!this.dbPath) {
      const base = this.explicitDataPath ?? getDataPathSafe();
      this.dbPath = join(base, USER_PROMPTS_DB_NAME);
    }
    return this.dbPath;
  }

  /** 测试用：重置连接 */
  reset(): void {
    this.db = null;
    this.initPromise = null;
    // 一并清掉解析结果，让重新 initConfig 后的目录生效
    this.dbPath = null;
  }

  private async initialize(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = (async () => {
      const path = this.resolveDbPath();
      // connect 不会自建父目录，目录缺失会静默丢写入
      mkdirSync(dirname(path), { recursive: true });
      const db = await connect(path);
      await db.exec(SCHEMA);
      // 启动时释放遗留 claim，崩溃恢复
      await db.run("UPDATE user_prompts SET captured = 0 WHERE captured = 2");
      this.db = db;
    })();
    try {
      await this.initPromise;
    } catch (error) {
      this.initPromise = null;
      this.db = null;
      throw error;
    }
  }

  private async ready(): Promise<Database> {
    await this.initialize();
    if (!this.db) throw new Error("user-prompt store not initialized");
    return this.db;
  }

  /** 幂等保存，同 session 与 message 只存一条 */
  async savePrompt(sessionId: string, messageId: string, projectPath: string, content: string): Promise<string> {
    const db = await this.ready();
    const id = newId();
    const now = Date.now();
    const result = await db.run(
      `INSERT INTO user_prompts (id, session_id, message_id, project_path, content, created_at, captured)
       SELECT ?, ?, ?, ?, ?, ?, 0
       WHERE NOT EXISTS (SELECT 1 FROM user_prompts WHERE session_id = ? AND message_id = ?)`,
      [id, sessionId, messageId, projectPath, content, now, sessionId, messageId],
    );
    if (result.changes > 0) return id;
    const existing = await db.get(
      "SELECT id FROM user_prompts WHERE session_id = ? AND message_id = ? ORDER BY created_at ASC LIMIT 1",
      [sessionId, messageId],
    );
    if (existing?.id) return String(existing.id);
    throw new Error("failed to save or locate user prompt");
  }

  async getUncapturedPromptsForSession(sessionId: string): Promise<UserPrompt[]> {
    const db = await this.ready();
    const maxRetries = getConfig().autoCaptureMaxRetries;
    const rows = await db.all(
      `SELECT * FROM user_prompts
       WHERE session_id = ? AND captured = 0 AND capture_attempts < ?
       ORDER BY created_at ASC`,
      [sessionId, maxRetries],
    );
    return (rows as Record<string, unknown>[]).map(rowToPrompt);
  }

  async countUnanalyzedForUserLearning(): Promise<number> {
    const db = await this.ready();
    const row = await db.get("SELECT COUNT(*) as count FROM user_prompts WHERE user_learning_captured = 0");
    return Number(row?.count ?? 0);
  }

  async getPromptsForUserLearning(limit: number): Promise<UserPrompt[]> {
    const db = await this.ready();
    const rows = await db.all(
      "SELECT * FROM user_prompts WHERE user_learning_captured = 0 ORDER BY created_at ASC LIMIT ?",
      [limit],
    );
    return (rows as Record<string, unknown>[]).map(rowToPrompt);
  }

  async claimPrompt(promptId: string): Promise<boolean> {
    const db = await this.ready();
    const result = await db.run("UPDATE user_prompts SET captured = 2 WHERE id = ? AND captured = 0", [promptId]);
    return result.changes > 0;
  }

  async releaseClaim(promptId: string): Promise<void> {
    const db = await this.ready();
    await db.run("UPDATE user_prompts SET captured = 0 WHERE id = ? AND captured = 2", [promptId]);
  }

  async recordFailedAttempt(promptId: string): Promise<void> {
    const db = await this.ready();
    await db.run("UPDATE user_prompts SET capture_attempts = capture_attempts + 1 WHERE id = ?", [promptId]);
  }

  async markAsCaptured(promptId: string): Promise<void> {
    const db = await this.ready();
    await db.run("UPDATE user_prompts SET captured = 1 WHERE id = ?", [promptId]);
  }

  /** 原子标记已捕获并关联记忆。两步分开写时进程中断会留下 claim 态，重启后重置导致重复捕获 */
  async markCapturedWithMemory(promptId: string, memoryId: string): Promise<void> {
    const db = await this.ready();
    await db.run("UPDATE user_prompts SET captured = 1, linked_memory_id = ? WHERE id = ?", [memoryId, promptId]);
  }

  /** 查已写记忆但状态未收敛的行，claim 中断残留 */
  async listInconsistentCaptures(): Promise<UserPrompt[]> {
    const db = await this.ready();
    const rows = await db.all("SELECT * FROM user_prompts WHERE captured = 2");
    return (rows as Record<string, unknown>[]).map(rowToPrompt);
  }

  async deletePrompt(promptId: string): Promise<void> {
    const db = await this.ready();
    await db.run("DELETE FROM user_prompts WHERE id = ?", [promptId]);
  }

  async linkMemoryToPrompt(promptId: string, memoryId: string): Promise<void> {
    const db = await this.ready();
    await db.run("UPDATE user_prompts SET linked_memory_id = ? WHERE id = ?", [memoryId, promptId]);
  }

  async markMultipleAsUserLearningCaptured(promptIds: string[]): Promise<void> {
    if (promptIds.length === 0) return;
    const db = await this.ready();
    const placeholders = promptIds.map(() => "?").join(",");
    await db.run(`UPDATE user_prompts SET user_learning_captured = 1 WHERE id IN (${placeholders})`, promptIds);
  }

  async deleteOldPrompts(cutoffTime: number): Promise<number> {
    const db = await this.ready();
    const result = await db.run("DELETE FROM user_prompts WHERE created_at < ?", [cutoffTime]);
    return result.changes;
  }

  async close(): Promise<void> {
    if (this.db) {
      try {
        await this.db.close();
      } catch (error) {
        log("user-prompt store close failed", { error: String(error) });
      }
      this.db = null;
      this.initPromise = null;
    }
  }
}

function getDataPathSafe(): string {
  try {
    return getConfig().dataPath;
  } catch {
    return join(process.cwd(), "data");
  }
}

// 模块级单例，默认使用配置 dataPath
export const userPromptStore = new UserPromptStore();
