// 密钥解析：支持明文、env://NAME、file:///path 三种格式
import { readFileSync } from "node:fs";

export function resolveSecretValue(value: string | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("env://")) {
    const name = trimmed.slice(6);
    if (!name) return undefined;
    return process.env[name];
  }

  if (trimmed.startsWith("file://")) {
    const path = trimmed.slice(7);
    try {
      return readFileSync(path, "utf-8").trim();
    } catch {
      return undefined;
    }
  }

  return trimmed;
}
