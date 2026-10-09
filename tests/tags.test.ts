// 项目身份标签单测：标记文件优先、容器标签格式、目录名
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findMarkerProjectRoot,
  getProjectTagInfo,
  getUserTagInfo,
  getProjectName,
  getTags,
} from "../src/services/tags.js";
import { SCOPE_HASH_PATTERN } from "../src/services/memory-scope.js";

let base: string;
let markerDir: string;
let nestedDir: string;
let plainDir: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "dsh-mem-tags-"));
  // 标记目录：marker 根 + 嵌套子目录
  markerDir = join(base, "marker-root");
  nestedDir = join(markerDir, "nested", "deep");
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(join(markerDir, ".dsh-mem-project"), "");
  // 普通目录：无标记无 git
  plainDir = join(base, "plain");
  mkdirSync(plainDir, { recursive: true });
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("findMarkerProjectRoot", () => {
  it("子目录向上找到标记目录", () => {
    expect(findMarkerProjectRoot(nestedDir)).toBe(markerDir);
  });

  it("无标记返回 null", () => {
    expect(findMarkerProjectRoot(plainDir)).toBeNull();
  });
});

describe("getProjectTagInfo", () => {
  it("标记钉定项目根，tag 形如 dsh_project_<16hex>", () => {
    const info = getProjectTagInfo(nestedDir);
    expect(info.projectPath).toBe(markerDir);
    expect(info.tag).toMatch(/^dsh_project_[a-f0-9]{16}$/);
    expect(info.projectName).toBe("marker-root");
  });

  it("无标记无 git 时回退到目录本身", () => {
    const info = getProjectTagInfo(plainDir);
    expect(info.tag).toMatch(/^dsh_project_[a-f0-9]{16}$/);
    expect(info.projectPath).toBe(plainDir);
  });

  it("同一目录身份稳定，不同目录 hash 不同", () => {
    const a = getProjectTagInfo(plainDir);
    const b = getProjectTagInfo(plainDir);
    const c = getProjectTagInfo(nestedDir);
    expect(a.tag).toBe(b.tag);
    expect(a.tag).not.toBe(c.tag);
  });
});

describe("getUserTagInfo", () => {
  it("无 git 环境回退到用户名，tag 形如 dsh_user_<16hex>", () => {
    const info = getUserTagInfo(plainDir);
    expect(info.tag).toMatch(/^dsh_user_[a-f0-9]{16}$/);
    expect(info.displayName).toBeTruthy();
  });
});

describe("getTags", () => {
  it("返回 user + project 两组标签", () => {
    const tags = getTags(nestedDir);
    expect(tags.user.tag).toMatch(/^dsh_user_[a-f0-9]{16}$/);
    expect(tags.project.tag).toMatch(/^dsh_project_[a-f0-9]{16}$/);
    expect(SCOPE_HASH_PATTERN.test(tags.project.tag.split("_").pop()!)).toBe(true);
  });
});

describe("getProjectName", () => {
  it("取路径最后一段", () => {
    expect(getProjectName(join("a", "b", "c"))).toBe("c");
  });
});
