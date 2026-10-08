// 配置加载测试：大小写归一、旧键兼容、scope 归一、初始化幂等
import { describe, expect, it, beforeEach, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initConfig, resetConfig, getConfig, DATA_DIR } from "../src/config.js";

// 测试隔离：禁用 cwd/包根探测，避免读到仓库真实 config.jsonc
beforeAll(() => {
  process.env.DSH_MEM_CONFIG_ISOLATED = "1";
});
afterAll(() => {
  delete process.env.DSH_MEM_CONFIG_ISOLATED;
});

function makeWorkspace(configJson?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mem-cfg-"));
  if (configJson !== undefined) writeFileSync(join(dir, "config.jsonc"), configJson, "utf-8");
  return dir;
}

// JSON 字符串里反斜杠是转义符，dataPath 用正斜杠写进配置
function jsonPath(p: string): string {
  return p.replace(/\\/g, "/");
}

describe("initConfig", () => {
  beforeEach(() => resetConfig());

  it("无配置文件时返回全默认", () => {
    const dir = makeWorkspace();
    const cfg = initConfig(dir);
    expect(cfg.dataPath).toBe(DATA_DIR);
    expect(cfg.embedding.model).toBe("");
    expect(cfg.embedding.baseUrl).toBeUndefined();
    expect(cfg.embedding.dimensions).toBeUndefined();
    expect(cfg.llm.platform).toBe("openai");
    expect(cfg.similarityThreshold).toBe(0.8);
    expect(cfg.autoCaptureMaxContext).toBe(131072);
    expect(cfg.autoCaptureLanguage).toBe("auto");
    expect(cfg.memoryDefaultScope).toBe("project");
    expect(cfg.databaseEncryptionEnabled).toBe(false);
  });

  it("workspace config.jsonc 覆盖默认值", () => {
    const dir = makeWorkspace(`{
      // 自定义
      "similarityThreshold": 0.75,
      "maxMemories": 5,
      "embedding": { "model": "text-embedding-3-small", "baseUrl": "https://api.openai.com/v1", "apiKey": "env://K", "dimensions": 1536 },
      "llm": { "platform": "anthropic", "model": "claude-3-5-haiku" },
    }`);
    const cfg = initConfig(dir);
    expect(cfg.similarityThreshold).toBe(0.75);
    expect(cfg.maxMemories).toBe(5);
    expect(cfg.embedding.model).toBe("text-embedding-3-small");
    expect(cfg.embedding.baseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.embedding.apiKey).toBe("env://K");
    expect(cfg.embedding.dimensions).toBe(1536);
    expect(cfg.llm.platform).toBe("anthropic");
    // llm 部分合并：未覆盖字段保留默认
    expect(cfg.llm.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("顶层 key 大小写归一", () => {
    const dir = makeWorkspace(`{
      "datapath": "${jsonPath(join(mkdtempSync(join(tmpdir(), "dsh-mem-case-")), "x-data"))}",
      "SIMILARITYTHRESHOLD": 0.7,
      "MaxMemories": 2
    }`);
    const cfg = initConfig(dir);
    expect(cfg.dataPath.endsWith("x-data")).toBe(true);
    expect(cfg.similarityThreshold).toBe(0.7);
    expect(cfg.maxMemories).toBe(2);
  });

  it("旧键 autoCaptureMaxContextBytes 映射到 autoCaptureMaxContext", () => {
    const dir = makeWorkspace(`{ "autoCaptureMaxContextBytes": 65536 }`);
    const cfg = initConfig(dir);
    expect(cfg.autoCaptureMaxContext).toBe(65536);
  });

  it("旧 scope 值 all-projects 归一为 all", () => {
    const dir = makeWorkspace(`{ "memoryDefaultScope": "all-projects" }`);
    const cfg = initConfig(dir);
    expect(cfg.memoryDefaultScope).toBe("all");
  });

  it("dataPath 自定义被解析为绝对路径", () => {
    const dir = makeWorkspace(`{ "dataPath": "${jsonPath(join(mkdtempSync(join(tmpdir(), "dsh-mem-dp-")), "my-data"))}" }`);
    const cfg = initConfig(dir);
    expect(cfg.dataPath).not.toBe(DATA_DIR);
    expect(cfg.dataPath.endsWith("my-data")).toBe(true);
  });

  it("重复调用幂等（返回同一实例）", () => {
    const dir = makeWorkspace();
    expect(initConfig(dir)).toBe(initConfig(dir));
  });

  it("resetConfig 后可重新加载", () => {
    const dir = makeWorkspace(`{ "similarityThreshold": 0.8 }`);
    expect(initConfig(dir).similarityThreshold).toBe(0.8);
    resetConfig();
    const dir2 = makeWorkspace(`{ "similarityThreshold": 0.55 }`);
    expect(initConfig(dir2).similarityThreshold).toBe(0.55);
  });

  it("未初始化时 getConfig 抛错", () => {
    expect(() => getConfig()).toThrow(/not initialized/);
  });

  it("非法 jsonc 被忽略并回退默认", () => {
    const dir = makeWorkspace("{ not valid json !!!");
    const cfg = initConfig(dir);
    expect(cfg.similarityThreshold).toBe(0.8);
  });

  it("data 目录不存在时自动创建", () => {
    const target = join(mkdtempSync(join(tmpdir(), "dsh-mem-d-")), "fresh-data");
    const dir = makeWorkspace(`{ "dataPath": "${jsonPath(target)}" }`);
    const cfg = initConfig(dir);
    expect(existsSync(cfg.dataPath)).toBe(true);
  });
});
