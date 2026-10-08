// 模型下载器测试：命令构造（不实际下载）
import { describe, expect, it } from "vitest";
import type { ModelSource } from "../src/types.js";
import { buildUvxArgs, formatCommand } from "../src/services/model-downloader.js";

const MS_SOURCE: ModelSource = { kind: "ms", org: "org", repo: "repo" };
const HF_SOURCE: ModelSource = { kind: "hf", org: "org", repo: "repo" };

describe("buildUvxArgs", () => {
  it("modelscope：--from modelscope-hub + modelscope download <repo>（不带 local-dir 进默认缓存）", () => {
    const args = buildUvxArgs(MS_SOURCE, "org/repo");
    expect(args[0]).toBe("--from");
    expect(args[1]).toBe("modelscope-hub");
    expect(args[2]).toBe("modelscope");
    expect(args[3]).toBe("download");
    expect(args[4]).toBe("org/repo");
    expect(args).not.toContain("--local-dir");
  });

  it("modelscope 带 local-dir 时追加 --local-dir", () => {
    const args = buildUvxArgs(MS_SOURCE, "org/repo", "D:/data/models/eg2");
    expect(args).toContain("--local-dir");
    expect(args.at(-1)).toBe("D:/data/models/eg2");
  });

  it("hf：--from huggingface_hub[cli] + hf download", () => {
    const args = buildUvxArgs(HF_SOURCE, "org/repo", "D:/models");
    expect(args[1]).toBe("huggingface_hub[cli]");
    expect(args[2]).toBe("hf");
    expect(args[3]).toBe("download");
    expect(args[4]).toBe("org/repo");
    expect(args.at(-1)).toBe("D:/models");
  });

  it("shell:false 语义：参数不经过 shell 二次解析", () => {
    const args = buildUvxArgs(HF_SOURCE, "x/y", "dir");
    expect(args).toContain("x/y");
  });
});

describe("formatCommand", () => {
  it("含空格参数加引号便于复制", () => {
    expect(formatCommand(["--from", "huggingface_hub[cli]", "hf", "download"])).toBe(
      'uvx --from "huggingface_hub[cli]" hf download'
    );
  });
});
