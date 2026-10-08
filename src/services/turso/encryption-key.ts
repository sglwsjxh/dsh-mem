// 数据库加密密钥：生成、校验与解析
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { getConfig } from "../../config.js";
import { resolveSecretValue } from "../secret-resolver.js";
import type { EncryptionOpts } from "@tursodatabase/database-common";

export const DEFAULT_DATABASE_ENCRYPTION_KEY_PATH = join(
  homedir(),
  ".dsh",
  "dsh-mem-db.key"
);

const HEX_KEY_RE = /^[0-9a-fA-F]+$/;

export function isValidDatabaseEncryptionHexKey(value: string): boolean {
  const trimmed = value.trim();
  return HEX_KEY_RE.test(trimmed) && (trimmed.length === 32 || trimmed.length === 64);
}

function expandPath(path: string): string {
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (path === "~") return homedir();
  return path;
}

function encryptionMarkerPath(): string {
  return join(getConfig().dataPath, ".tursodb-encrypted-v1");
}

/** 新建 AES-256 密钥文件，已有加密库时拒绝（防丢数据） */
export function generateDatabaseEncryptionKeyFile(
  keyPath: string = DEFAULT_DATABASE_ENCRYPTION_KEY_PATH
): string {
  const resolved = expandPath(keyPath);
  if (existsSync(encryptionMarkerPath())) {
    throw new Error(
      `Cannot generate a new database encryption key at ${resolved}: ` +
        `encrypted databases already exist under ${getConfig().dataPath}. ` +
        `Restore the original key file first.`
    );
  }

  const dir = dirname(resolved);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const hexkey = randomBytes(32).toString("hex");
  writeFileSync(resolved, `${hexkey}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
  if (platform() !== "win32") {
    try {
      chmodSync(resolved, 0o600);
    } catch {
      // 写入时已设权限，失败可忽略
    }
  }
  return hexkey;
}

/** 确保密钥文件存在，返回其十六进制内容 */
export function ensureDatabaseEncryptionKeyFile(
  keyPath: string = DEFAULT_DATABASE_ENCRYPTION_KEY_PATH
): string {
  const resolved = expandPath(keyPath);
  if (!existsSync(resolved)) return generateDatabaseEncryptionKeyFile(resolved);

  const content = readFileSync(resolved, "utf-8").trim();
  if (!isValidDatabaseEncryptionHexKey(content)) {
    throw new Error(
      `Database encryption key file ${resolved} is invalid. ` +
        `Expected a 32- or 64-character hex string (AES-128 or AES-256).`
    );
  }

  if (platform() !== "win32") {
    try {
      chmodSync(resolved, 0o600);
    } catch {
      // 特殊文件系统上可忽略
    }
  }
  return content;
}

/** 解析生效的加密密钥，启用且未配置时自动生成默认密钥文件 */
export function resolveOrCreateDatabaseEncryptionKey(): string | null {
  const cfg = getConfig();
  const enabled = cfg.databaseEncryptionEnabled === true;
  const raw = cfg.databaseEncryptionKey?.trim();

  if (!enabled && !raw) return null;

  // 配置里直接给十六进制密钥
  if (raw && isValidDatabaseEncryptionHexKey(raw) && !raw.includes("://")) {
    return raw.trim();
  }

  if (raw?.startsWith("env://")) {
    const value = resolveSecretValue(raw)?.trim();
    if (!value || !isValidDatabaseEncryptionHexKey(value)) {
      throw new Error(`databaseEncryptionKey ${raw} must resolve to a 32- or 64-character hex string`);
    }
    return value;
  }

  if (raw?.startsWith("file://")) {
    const filePath = expandPath(raw.slice(7));
    return ensureDatabaseEncryptionKeyFile(filePath);
  }

  if (raw) {
    // 裸路径按文件路径处理
    if (raw.includes("/") || raw.startsWith("~")) return ensureDatabaseEncryptionKeyFile(raw);
    throw new Error("databaseEncryptionKey must be env://VAR, file://path, or a 32/64-char hex string");
  }

  // 已启用但未配置密钥：生成默认密钥文件
  return ensureDatabaseEncryptionKeyFile(DEFAULT_DATABASE_ENCRYPTION_KEY_PATH);
}

/** 组装连接用加密参数，未启用时返回 null */
export function resolveDatabaseEncryption(): EncryptionOpts | null {
  const hexkey = resolveOrCreateDatabaseEncryptionKey();
  if (!hexkey) return null;
  return { cipher: "aes256gcm", hexkey };
}
