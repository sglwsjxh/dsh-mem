// 用户画像持久化：独立 SQLite 文件，含版本与变更日志
import { connect, type Database } from "@tursodatabase/database";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfig } from "../config.js";
import { log } from "./logger.js";
import type { UserProfileData, UserProfileRecord } from "../types.js";
import type { UserProfileManagerLike } from "./contracts.js";

const USER_PROFILE_DB_NAME = "user-profile.db";
const CHANGELOG_RETENTION = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  user_name TEXT NOT NULL,
  user_email TEXT NOT NULL,
  profile_data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_analyzed_at INTEGER NOT NULL,
  total_prompts_analyzed INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS user_profile_changelogs (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  change_type TEXT NOT NULL,
  change_summary TEXT NOT NULL,
  profile_data_snapshot TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles (user_id);
CREATE INDEX IF NOT EXISTS idx_profile_changelogs_profile ON user_profile_changelogs (profile_id, version DESC);
`;

/** 描述相似度合并阈值：同义描述归并 */
const DESCRIPTION_MERGE_THRESHOLD = 0.85;

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function getDataPathSafe(): string {
  try {
    return getConfig().dataPath;
  } catch {
    return process.cwd();
  }
}

function rowToProfile(row: Record<string, unknown>): UserProfileRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    displayName: String(row.display_name),
    userName: String(row.user_name),
    userEmail: String(row.user_email),
    profileData: String(row.profile_data),
    version: Number(row.version),
    lastAnalyzedAt: Number(row.last_analyzed_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.last_analyzed_at),
  };
}

/** 文本归一化后的相似度：词集合 Jaccard，够用且零依赖 */
function descriptionSimilarity(a: string, b: string): number {
  const tokenize = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .split(/[\s,.;:!?，。；：！？、]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 1),
    );
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 || sb.size === 0) return a.trim() === b.trim() ? 1 : 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

type ProfileItem = { category: string; description: string; confidence: number; frequency: number; evidence: string[]; lastSeen: number };

/** 合并同类条目：描述相似则累加频次并提升置信度，否则追加 */
function mergeItems(existing: ProfileItem[], incoming: ProfileItem[]): ProfileItem[] {
  const out = [...existing];
  for (const item of incoming) {
    const hit = out.find((e) => descriptionSimilarity(e.description, item.description) >= DESCRIPTION_MERGE_THRESHOLD);
    if (hit) {
      hit.frequency += item.frequency;
      hit.confidence = Math.min(1, Math.max(hit.confidence, item.confidence) + 0.05);
      hit.lastSeen = Math.max(hit.lastSeen, item.lastSeen);
      for (const ev of item.evidence) if (!hit.evidence.includes(ev)) hit.evidence.push(ev);
      continue;
    }
    out.push({ ...item });
  }
  return out;
}

/** 陈旧条目衰减：超过 staleDays 未见则置信度打折，低于阈值移除 */
function decayItems(items: ProfileItem[], staleDays: number): ProfileItem[] {
  const cutoff = Date.now() - staleDays * 86400000;
  return items
    .map((item) => (item.lastSeen < cutoff ? { ...item, confidence: item.confidence * 0.8 } : item))
    .filter((item) => item.confidence >= 0.15);
}

export class UserProfileManager implements UserProfileManagerLike {
  private db: Database | null = null;
  private initPromise: Promise<void> | null = null;
  /** 显式数据目录（测试注入用）；未传则首次使用时按生效配置解析 */
  private readonly explicitDataPath?: string;
  private dbPath: string | null = null;

  constructor(dataPath?: string) {
    this.explicitDataPath = dataPath;
  }

  /** 延迟解析 dbPath，原因同 UserPromptStore：单例构造早于 initConfig */
  private resolveDbPath(): string {
    if (!this.dbPath) {
      const base = this.explicitDataPath ?? getDataPathSafe();
      this.dbPath = join(base, USER_PROFILE_DB_NAME);
    }
    return this.dbPath;
  }

  /** 测试用：重置连接 */
  reset(): void {
    this.db = null;
    this.initPromise = null;
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
      mkdirSync(dirname(path), { recursive: true });
      const db = await connect(path);
      await db.exec(SCHEMA);
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
    if (!this.db) throw new Error("user profile store not initialized");
    return this.db;
  }

  async getActiveProfile(userId: string): Promise<UserProfileRecord | null> {
    const db = await this.ready();
    const row = await db.get("SELECT * FROM user_profiles WHERE user_id = ? AND is_active = 1", [userId]);
    return row ? rowToProfile(row) : null;
  }

  async createProfile(
    userId: string,
    displayName: string,
    userName: string,
    userEmail: string,
    data: UserProfileData,
    analyzedCount: number,
  ): Promise<void> {
    const db = await this.ready();
    const now = Date.now();
    const id = newId("profile");
    await db.run(
      `INSERT INTO user_profiles
       (id, user_id, display_name, user_name, user_email, profile_data, version, created_at, last_analyzed_at, total_prompts_analyzed, is_active)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1)`,
      [id, userId, displayName, userName, userEmail, JSON.stringify(data), now, now, analyzedCount],
    );
    await this.writeChangelog(db, id, 1, "create", "profile created", data);
  }

  async updateProfile(profileId: string, data: UserProfileData, analyzedCount: number, summary: string): Promise<boolean> {
    const db = await this.ready();
    const existing = await db.get("SELECT version, total_prompts_analyzed FROM user_profiles WHERE id = ?", [profileId]);
    if (!existing) return false;
    const version = Number(existing.version) + 1;
    const totalAnalyzed = Number(existing.total_prompts_analyzed) + analyzedCount;
    await db.run(
      `UPDATE user_profiles SET profile_data = ?, version = ?, last_analyzed_at = ?, total_prompts_analyzed = ? WHERE id = ?`,
      [JSON.stringify(data), version, Date.now(), totalAnalyzed, profileId],
    );
    await this.writeChangelog(db, profileId, version, "update", summary, data);
    return true;
  }

  /** 合并画像数据：相似描述归并 + 陈旧衰减 */
  async mergeProfileData(
    existing: UserProfileData,
    incoming: Partial<UserProfileData>,
    _undefined?: undefined,
    _profileId?: string,
  ): Promise<UserProfileData> {
    const staleDays = getConfig().userProfileStaleDays;
    return {
      preferences: decayItems(mergeItems(existing.preferences ?? [], incoming.preferences ?? []), staleDays),
      patterns: decayItems(mergeItems(existing.patterns ?? [], incoming.patterns ?? []), staleDays),
      workflows: decayItems(mergeItems(existing.workflows ?? [], incoming.workflows ?? []), staleDays),
    };
  }

  private async writeChangelog(
    db: Database,
    profileId: string,
    version: number,
    changeType: string,
    summary: string,
    snapshot: UserProfileData,
  ): Promise<void> {
    try {
      await db.run(
        `INSERT INTO user_profile_changelogs (id, profile_id, version, change_type, change_summary, profile_data_snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newId("changelog"), profileId, version, changeType, summary, JSON.stringify(snapshot), Date.now()],
      );
      // 保留最近 N 条
      await db.run(
        `DELETE FROM user_profile_changelogs WHERE profile_id = ? AND id NOT IN (
           SELECT id FROM user_profile_changelogs WHERE profile_id = ? ORDER BY version DESC LIMIT ?
         )`,
        [profileId, profileId, CHANGELOG_RETENTION],
      );
    } catch (error) {
      // 变更日志失败不影响主流程
      log("profile changelog write failed", { error: String(error) });
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
    this.initPromise = null;
  }
}

let manager: UserProfileManager | null = null;

export function getUserProfileManager(dataPath?: string): UserProfileManager {
  if (!manager) manager = new UserProfileManager(dataPath);
  return manager;
}

export function resetUserProfileManager(): void {
  if (manager) void manager.close();
  manager = null;
}
