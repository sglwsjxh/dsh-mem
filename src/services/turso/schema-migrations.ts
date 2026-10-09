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

// 分片模式迁移：按 PRAGMA user_version 增量建表
import type { TursoDb } from "./turso-db.js";

export type SchemaMigration = {
  version: number;
  description: string;
  statements: Array<{ sql: string; args?: Array<string | number | null> }>;
};

async function getUserVersion(db: TursoDb): Promise<number> {
  const row = await db.get<{ user_version?: number }>(`PRAGMA user_version`);
  return Number(row?.user_version ?? 0);
}

async function setUserVersion(db: TursoDb, version: number): Promise<void> {
  await db.run(`PRAGMA user_version = ${Math.trunc(version)}`);
}

export async function applySchemaMigrations(
  db: TursoDb,
  migrations: SchemaMigration[],
  options?: { label?: string }
): Promise<number> {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const current = await getUserVersion(db);
  const pending = sorted.filter((migration) => migration.version > current);
  if (pending.length === 0) return current;

  const target = pending[pending.length - 1]!.version;
  for (const migration of pending) {
    await db.batch(migration.statements, "write");
    await setUserVersion(db, migration.version);
  }
  return target;
}

/** 记忆分片模式，精确余弦扫描，无 DiskANN 索引 */
export function memoryShardMigrations(dimensions: number): SchemaMigration[] {
  const dims = Math.trunc(dimensions);
  return [
    {
      version: 1,
      description: "Baseline memories + shard_metadata",
      statements: [
        {
          sql: `
            CREATE TABLE IF NOT EXISTS shard_metadata (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            )
          `,
        },
        {
          sql: `
            CREATE TABLE IF NOT EXISTS memories (
              id TEXT PRIMARY KEY,
              content TEXT NOT NULL,
              vector F32_BLOB(${dims}) NOT NULL,
              tags_vector F32_BLOB(${dims}),
              container_tag TEXT NOT NULL,
              tags TEXT,
              type TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              metadata TEXT,
              display_name TEXT,
              user_name TEXT,
              user_email TEXT,
              project_path TEXT,
              project_name TEXT,
              git_repo_url TEXT,
              is_pinned INTEGER DEFAULT 0
            )
          `,
        },
        { sql: `CREATE INDEX IF NOT EXISTS idx_container_tag ON memories(container_tag)` },
        { sql: `CREATE INDEX IF NOT EXISTS idx_type ON memories(type)` },
        { sql: `CREATE INDEX IF NOT EXISTS idx_created_at ON memories(created_at DESC)` },
        { sql: `CREATE INDEX IF NOT EXISTS idx_is_pinned ON memories(is_pinned)` },
      ],
    },
    {
      version: 2,
      description: "Indexed session_id for session lookup",
      statements: [
        { sql: `ALTER TABLE memories ADD COLUMN session_id TEXT` },
        { sql: `CREATE INDEX IF NOT EXISTS idx_session_id ON memories(session_id)` },
        {
          sql: `
            UPDATE memories
            SET session_id = json_extract(metadata, '$.sessionID')
            WHERE metadata IS NOT NULL
              AND session_id IS NULL
              AND json_extract(metadata, '$.sessionID') IS NOT NULL
          `,
        },
      ],
    },
  ];
}

/** 分片注册表 */
export const METADATA_DB_MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    description: "Baseline shards registry",
    statements: [
      {
        sql: `
          CREATE TABLE IF NOT EXISTS shards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope TEXT NOT NULL,
            scope_hash TEXT NOT NULL,
            shard_index INTEGER NOT NULL,
            db_path TEXT NOT NULL,
            vector_count INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            created_at INTEGER NOT NULL,
            UNIQUE(scope, scope_hash, shard_index)
          )
        `,
      },
      {
        sql: `
          CREATE INDEX IF NOT EXISTS idx_active_shards
          ON shards(scope, scope_hash, is_active)
        `,
      },
    ],
  },
];

/** 用户 prompt 记录表，宿主集成写入 */
export const USER_PROMPTS_MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    description: "Baseline user_prompts",
    statements: [
      {
        sql: `
          CREATE TABLE IF NOT EXISTS user_prompts (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            project_path TEXT,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            captured INTEGER DEFAULT 0,
            capture_attempts INTEGER DEFAULT 0,
            linked_memory_id TEXT
          )
        `,
      },
      { sql: "CREATE INDEX IF NOT EXISTS idx_user_prompts_session ON user_prompts(session_id)" },
      { sql: "CREATE INDEX IF NOT EXISTS idx_user_prompts_captured ON user_prompts(captured)" },
      { sql: "CREATE INDEX IF NOT EXISTS idx_user_prompts_created ON user_prompts(created_at DESC)" },
      { sql: "CREATE INDEX IF NOT EXISTS idx_user_prompts_project ON user_prompts(project_path)" },
    ],
  },
];

/** 用户画像表，宿主集成写入 */
export const USER_PROFILES_MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    description: "Baseline user_profiles + changelogs",
    statements: [
      {
        sql: `
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
          )
        `,
      },
      {
        sql: `
          CREATE TABLE IF NOT EXISTS user_profile_changelogs (
            id TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            change_type TEXT NOT NULL,
            change_summary TEXT NOT NULL,
            profile_data_snapshot TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (profile_id) REFERENCES user_profiles(id) ON DELETE CASCADE
          )
        `,
      },
      { sql: "CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id)" },
      { sql: "CREATE INDEX IF NOT EXISTS idx_user_profiles_is_active ON user_profiles(is_active)" },
      {
        sql: "CREATE INDEX IF NOT EXISTS idx_user_profile_changelogs_profile_id ON user_profile_changelogs(profile_id)",
      },
    ],
  },
];
