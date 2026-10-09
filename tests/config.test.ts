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
// 配置加载测试：单路径 ~/.dsh/dsh-mem.jsonc、归一化、fail-fast
// 用 vi.mock 拦截 fs，把固定配置路径重定向到临时文件
import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync as realExists, readFileSync as realRead } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const fakeHome = mkdtempSync(join(tmpdir(), "dsh-mem-cfg-"));
const mockConfigPath = join(fakeHome, "dsh-mem.jsonc");

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const isConfigPath = (p: unknown) => typeof p === "string" && p.replace(/\\/g, "/").endsWith(".dsh/dsh-mem.jsonc");
  const exists = actual.existsSync as unknown as (p: unknown) => boolean;
  const read = actual.readFileSync as unknown as (p: unknown, enc: BufferEncoding | undefined) => string;
  return {
    ...actual,
    existsSync: (p: unknown) => (isConfigPath(p) ? realExists(mockConfigPath) : exists(p)),
    readFileSync: (p: unknown, enc?: any) => (isConfigPath(p) ? realRead(mockConfigPath, enc) : read(p, enc)),
  };
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fakeHome };
});

// mock 就位后再加载被测模块
type ConfigModule = typeof import("../src/config.js");
let config: ConfigModule;

beforeEach(async () => {
  config = await import("../src/config.js");
  config.resetConfig();
  rmSync(mockConfigPath, { force: true });
});

afterAll(() => {
  config.resetConfig();
  rmSync(fakeHome, { recursive: true, force: true });
});

function writeConfig(content: string): void {
  writeFileSync(mockConfigPath, content, "utf-8");
}

describe("initConfig", () => {
  it("配置缺失返回 null，不抛错不探测其他路径", () => {
    expect(config.initConfig()).toBeNull();
    expect(config.isConfigured()).toBe(false);
  });

  it("正常配置：归一化默认值", () => {
    writeConfig(
      JSON.stringify({
        datapath: "./data",
        embedding: { model: "m1", baseurl: "https://e.example/v1", apikey: "k1" },
        llm: { platform: "openai", baseUrl: "https://l.example/v1", model: "gpt", apiKey: "k2" },
      }),
    );
    const cfg = config.initConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.embedding.model).toBe("m1");
    expect(cfg!.embedding.baseUrl).toBe("https://e.example/v1");
    expect(cfg!.similarityThreshold).toBe(0.5);
    expect(cfg!.memoryDefaultScope).toBe("project");
    expect(cfg!.autoCaptureMaxRetries).toBe(3);
    expect(config.isConfigured()).toBe(true);
  });

  it("datapath 相对路径相对 ~/.dsh 解析", () => {
    writeConfig(
      JSON.stringify({
        embedding: { model: "m", baseurl: "https://e.example/v1" },
        llm: { model: "l" },
      }),
    );
    const cfg = config.initConfig();
    const normalized = cfg!.dataPath.replace(/\\/g, "/");
    expect(normalized).toContain(".dsh/data");
  });

  it("dimensions 透传，不配置为 undefined", () => {
    writeConfig(
      JSON.stringify({
        embedding: { model: "m", baseurl: "https://e.example/v1", dimensions: 2048 },
        llm: { model: "l" },
      }),
    );
    const cfg = config.initConfig();
    expect(cfg!.embedding.dimensions).toBe(2048);
  });

  it("缺 embedding.model 报错并返回 null", () => {
    writeConfig(
      JSON.stringify({
        embedding: { baseurl: "https://e.example/v1" },
        llm: { model: "l" },
      }),
    );
    expect(config.initConfig()).toBeNull();
    expect(config.isConfigured()).toBe(false);
  });

  it("非法 jsonc 返回 null", () => {
    writeConfig("{ not valid");
    expect(config.initConfig()).toBeNull();
  });

  it("resetConfig 后可重新加载新内容", () => {
    writeConfig(
      JSON.stringify({
        embedding: { model: "a", baseurl: "https://e.example/v1" },
        llm: { model: "l" },
      }),
    );
    expect(config.initConfig()!.embedding.model).toBe("a");
    config.resetConfig();
    writeConfig(
      JSON.stringify({
        embedding: { model: "b", baseurl: "https://e.example/v1" },
        llm: { model: "l" },
      }),
    );
    expect(config.initConfig()!.embedding.model).toBe("b");
  });
});
