// 模型解析测试：model 字符串解析、缓存探测、量化偏好、统一定位入口
// 缓存布局用临时目录构造，环境变量注入缓存根，afterEach 还原并清理
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseModelRef, pickGgufFile, findCachedModel, resolveFileModel, resolveModelLocation } from "../src/services/model-resolve.js";

let cacheDir = "";
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = { HF_HUB_CACHE: process.env.HF_HUB_CACHE, MODELSCOPE_CACHE: process.env.MODELSCOPE_CACHE };
  cacheDir = mkdtempSync(join(tmpdir(), "dsh-mem-res-"));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// 造标准 HF 缓存布局：refs/main 指向 commit，返回 snapshot 目录
function makeHfSnapshot(org: string, repo: string, commit: string): string {
  const repoDir = join(cacheDir, `models--${org}--${repo}`);
  mkdirSync(join(repoDir, "refs"), { recursive: true });
  writeFileSync(join(repoDir, "refs", "main"), commit, "utf-8");
  const snapshot = join(repoDir, "snapshots", commit);
  mkdirSync(snapshot, { recursive: true });
  return snapshot;
}

function writeFile(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x", "utf-8");
  return path;
}

describe("parseModelRef", () => {
  it("识别 file/hf/ms 三种前缀形态", () => {
    expect(parseModelRef("file://C:/models/e2.gguf")).toEqual({ source: { kind: "file", path: "C:/models/e2.gguf" }, raw: "file://C:/models/e2.gguf" });
    expect(parseModelRef("hf://org/repo")).toEqual({ source: { kind: "hf", org: "org", repo: "repo" }, raw: "hf://org/repo" });
    expect(parseModelRef("ms://org/repo")).toEqual({ source: { kind: "ms", org: "org", repo: "repo" }, raw: "ms://org/repo" });
  });

  it("无法识别的形态按 openai 兜底", () => {
    expect(parseModelRef("text-embedding-3-small")).toEqual({ source: { kind: "openai" }, raw: "text-embedding-3-small" });
    expect(parseModelRef("")).toEqual({ source: { kind: "openai" }, raw: "" });
  });
});

describe("pickGgufFile", () => {
  it("空数组返回 null", () => {
    expect(pickGgufFile([])).toBeNull();
  });

  it("单文件直接返回", () => {
    expect(pickGgufFile(["only-Q2_K.gguf"])).toBe("only-Q2_K.gguf");
  });

  it("多文件按量化偏好 Q8_0 优先", () => {
    expect(pickGgufFile(["m-Q4_K_M.gguf", "m-Q8_0.gguf"])).toBe("m-Q8_0.gguf");
    expect(pickGgufFile(["m-Q8_0.gguf", "m-Q4_K_M.gguf"])).toBe("m-Q8_0.gguf");
  });

  it("无量化 tag 时按文件名稳定排序", () => {
    expect(pickGgufFile(["z.gguf", "a.gguf"])).toBe("a.gguf");
  });
});

describe("findCachedModel（HF 缓存）", () => {
  const SRC = { kind: "hf", org: "testorg", repo: "testrepo" } as const;

  it("refs/main 定位 snapshot：onnx 命中后 gguf 优先", () => {
    process.env.HF_HUB_CACHE = cacheDir;
    const snapshot = makeHfSnapshot("testorg", "testrepo", "c0ffee00");
    writeFile(join(snapshot, "config.json"));
    const onnxDir = join(snapshot, "onnx");
    writeFile(join(onnxDir, "model.onnx"));
    expect(findCachedModel(SRC)).toEqual({ kind: "onnx", dir: snapshot });
    // gguf 存在时优先于 onnx
    const gguf = writeFile(join(snapshot, "model-Q8_0.gguf"));
    expect(findCachedModel(SRC)).toEqual({ kind: "gguf", file: gguf });
  });

  it("缓存目录为空返回 null", () => {
    process.env.HF_HUB_CACHE = cacheDir;
    expect(findCachedModel(SRC)).toBeNull();
  });
});

describe("findCachedModel（ModelScope 缓存）", () => {
  const SRC = { kind: "ms", org: "msorg", repo: "msrepo" } as const;

  it("models/{org}/{repo} 布局命中 onnx", () => {
    process.env.MODELSCOPE_CACHE = cacheDir;
    const repoDir = join(cacheDir, "models", "msorg", "msrepo");
    writeFile(join(repoDir, "config.json"));
    writeFile(join(repoDir, "onnx", "model.onnx"));
    expect(findCachedModel(SRC)).toEqual({ kind: "onnx", dir: repoDir });
    // gguf 优先
    const gguf = writeFile(join(repoDir, "model-Q4_K_M.gguf"));
    expect(findCachedModel(SRC)).toEqual({ kind: "gguf", file: gguf });
  });

  it("直落 {org}/{repo} 布局命中 gguf", () => {
    process.env.MODELSCOPE_CACHE = cacheDir;
    const gguf = writeFile(join(cacheDir, "msorg", "msrepo", "model.gguf"));
    expect(findCachedModel(SRC)).toEqual({ kind: "gguf", file: gguf });
  });

  it("未命中返回 null", () => {
    process.env.MODELSCOPE_CACHE = cacheDir;
    expect(findCachedModel(SRC)).toBeNull();
  });
});

describe("resolveFileModel", () => {
  it("路径不存在抛错", () => {
    expect(() => resolveFileModel(join(cacheDir, "no-such.gguf"))).toThrow(/不存在/);
  });

  it("safetensors 文件抛错提示不支持", () => {
    const p = writeFile(join(cacheDir, "m.safetensors"));
    expect(() => resolveFileModel(p)).toThrow(/不支持 safetensors/);
  });

  it("gguf 文件直接返回", () => {
    const p = writeFile(join(cacheDir, "m.gguf"));
    expect(resolveFileModel(p)).toEqual({ kind: "gguf", file: resolve(p) });
  });
});

describe("resolveModelLocation", () => {
  it("file:// 形态直接定位，不触发下载", async () => {
    const p = writeFile(join(cacheDir, "m.gguf"));
    const ensure = vi.fn(async () => {});
    const ref = parseModelRef(`file://${p.replace(/\\/g, "/")}`);
    expect(await resolveModelLocation(ref, ensure)).toEqual({ kind: "gguf", file: resolve(p) });
    expect(ensure).not.toHaveBeenCalled();
  });

  it("缓存未命中：ensureDownloaded 后重新探测", async () => {
    process.env.HF_HUB_CACHE = cacheDir;
    const ref = parseModelRef("hf://dlorg/dlrepo");
    const ensure = vi.fn(async () => {
      const snapshot = makeHfSnapshot("dlorg", "dlrepo", "beef0000");
      writeFile(join(snapshot, "model-Q8_0.gguf"));
    });
    const expected = join(cacheDir, "models--dlorg--dlrepo", "snapshots", "beef0000", "model-Q8_0.gguf");
    expect(await resolveModelLocation(ref, ensure)).toEqual({ kind: "gguf", file: expected });
    expect(ensure).toHaveBeenCalledOnce();
  });
});
