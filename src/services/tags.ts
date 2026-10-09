// 项目身份标签：git root / .dsh-mem-project 标记识别 + sha256 前 16 位
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { normalize, resolve, isAbsolute, basename, dirname, join, delimiter, relative } from "node:path";
import { accessSync, constants, realpathSync, existsSync } from "node:fs";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * 标记文件：存在时把该目录钉为 dsh-mem 项目根。
 * monorepo 或多仓库工作区在根上放此文件，下面所有会话共用一个记忆库
 */
const PROJECT_MARKER = ".dsh-mem-project";

/** 容器标签前缀 */
export const CONTAINER_TAG_PREFIX = "dsh";

function canonicalPath(path: string): string {
  try {
    return process.platform === "win32"
      ? normalize(realpathSync.native(path))
      : normalize(realpathSync(path));
  } catch {
    return normalize(resolve(path));
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function findUntrustedProjectRoot(directory: string): string {
  let current = canonicalPath(directory);
  while (true) {
    if (existsSync(join(current, ".git")) || existsSync(join(current, PROJECT_MARKER))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return canonicalPath(directory);
    current = parent;
  }
}

interface GitCommand {
  executable: string;
  shell: false | string;
}

/** Windows 上解析可信 shell，拒绝项目目录内的 cmd */
function resolveTrustedWindowsShell(untrustedRoot: string): string | null {
  const candidates = [
    process.env.ComSpec,
    process.env.SystemRoot ? join(process.env.SystemRoot, "System32", "cmd.exe") : undefined,
  ];

  for (const path of candidates) {
    if (!path || !isAbsolute(path)) continue;
    try {
      accessSync(path, constants.X_OK);
      const candidate = canonicalPath(path);
      if (!isPathInside(untrustedRoot, candidate)) return candidate;
    } catch {
      // PATH 项不可读或不可信，跳过
    }
  }
  return null;
}

/**
 * 从 PATH 解析 git 可执行文件，拒绝位于项目目录内的副本。
 * 防止项目内投放的恶意 git.exe 被执行
 */
function resolveTrustedGitCommand(directory: string): GitCommand | null {
  const untrustedRoot = findUntrustedProjectRoot(directory);
  const executableNames = process.platform === "win32" ? ["git.exe", "git.cmd", "git.bat"] : ["git"];

  for (const rawEntry of (process.env.PATH ?? "").split(delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/, "$1");
    if (!entry || !isAbsolute(entry)) continue;

    for (const executableName of executableNames) {
      const candidatePath = join(entry, executableName);
      try {
        accessSync(candidatePath, constants.X_OK);
        const executable = canonicalPath(candidatePath);
        if (isPathInside(untrustedRoot, executable)) continue;

        if (executableName === "git.exe" || process.platform !== "win32") {
          return { executable, shell: false };
        }

        const shell = resolveTrustedWindowsShell(untrustedRoot);
        if (shell) return { executable, shell };
      } catch {
        // PATH 项不可读，跳过
      }
    }
  }

  return null;
}

function runGit(args: string[], directory: string = process.cwd()): string | null {
  const gitCommand = resolveTrustedGitCommand(directory);
  if (!gitCommand) return null;

  try {
    const output = execFileSync(gitCommand.executable, args, {
      encoding: "utf-8",
      cwd: directory,
      stdio: ["ignore", "pipe", "ignore"],
      shell: gitCommand.shell,
      windowsHide: true,
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

/** 从 directory 向上找 PROJECT_MARKER，找不到返回 null */
export function findMarkerProjectRoot(directory: string): string | null {
  let dir = resolve(directory);
  while (true) {
    if (existsSync(join(dir, PROJECT_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface TagInfo {
  tag: string;
  displayName: string;
  userName?: string;
  userEmail?: string;
  projectPath?: string;
  projectName?: string;
  gitRepoUrl?: string;
}

/** 项目侧标签：root 恒存在，字段必填，对齐 contracts.ts 的 TagsLike */
export interface ProjectTagInfo {
  tag: string;
  displayName: string;
  projectPath: string;
  projectName: string;
  gitRepoUrl?: string;
}

export function getGitEmail(directory: string = process.cwd()): string | null {
  return runGit(["config", "user.email"], directory);
}

export function getGitName(directory: string = process.cwd()): string | null {
  return runGit(["config", "user.name"], directory);
}

export function getGitRepoUrl(directory: string): string | null {
  return runGit(["config", "--get", "remote.origin.url"], directory);
}

export function getGitCommonDir(directory: string): string | null {
  try {
    const commonDir = runGit(["rev-parse", "--git-common-dir"], directory);
    if (!commonDir) return null;

    const resolved = isAbsolute(commonDir) ? normalize(commonDir) : normalize(resolve(directory, commonDir));
    if (existsSync(resolved)) {
      const canonical =
        process.platform === "win32" ? realpathSync.native(resolved) : realpathSync(resolved);
      return normalize(canonical);
    }
    return resolved;
  } catch {
    return null;
  }
}

export function getGitTopLevel(directory: string): string | null {
  return runGit(["rev-parse", "--show-toplevel"], directory);
}

// 仅 git 的回退逻辑，与标记识别入口分开
function getGitProjectRoot(directory: string): string {
  const commonDir = getGitCommonDir(directory);
  if (commonDir && basename(commonDir) === ".git") return dirname(commonDir);

  const topLevel = getGitTopLevel(directory);
  if (topLevel) return topLevel;

  return directory;
}

function getGitProjectIdentity(directory: string): string {
  const commonDir = getGitCommonDir(directory);
  if (commonDir) return `git-common:${commonDir}`;

  const gitRepoUrl = getGitRepoUrl(directory);
  if (gitRepoUrl) return `remote:${gitRepoUrl}`;

  return `path:${normalize(directory)}`;
}

export function getProjectRoot(directory: string): string {
  return findMarkerProjectRoot(directory) ?? getGitProjectRoot(directory);
}

export function getProjectIdentity(directory: string): string {
  const markerRoot = findMarkerProjectRoot(directory);
  return markerRoot ? `path:${markerRoot}` : getGitProjectIdentity(directory);
}

export function getProjectName(directory: string): string {
  const normalized = normalize(directory).replace(/\\/g, "/");
  const parts = normalized.split("/").filter((p) => p && p !== ".");
  return parts[parts.length - 1] || directory;
}

/** 用户身份：git 邮箱优先，回退用户名/环境变量 */
export function getUserTagInfo(directory: string = process.cwd()): TagInfo {
  const email = getGitEmail(directory);
  const name = getGitName(directory);

  if (email) {
    return {
      tag: `${CONTAINER_TAG_PREFIX}_user_${sha256(email)}`,
      displayName: name || email,
      userName: name || undefined,
      userEmail: email,
    };
  }

  const fallback = name || process.env.USER || process.env.USERNAME || "anonymous";
  return {
    tag: `${CONTAINER_TAG_PREFIX}_user_${sha256(fallback)}`,
    displayName: fallback,
    userName: fallback,
    userEmail: undefined,
  };
}

/** 项目身份：标记优先，回退 git common dir / remote / 路径 */
export function getProjectTagInfo(directory: string): TagInfo {
  // 标记只解析一次，root 与 identity 都从它推导
  const markerRoot = findMarkerProjectRoot(directory);
  const projectRoot = markerRoot ?? getGitProjectRoot(directory);
  const projectName = getProjectName(projectRoot);
  // 标记钉定时，git remote 属于内嵌子仓库，不取
  const gitRepoUrl = markerRoot ? null : getGitRepoUrl(directory);
  const projectIdentity = markerRoot ? `path:${markerRoot}` : getGitProjectIdentity(projectRoot);

  return {
    tag: `${CONTAINER_TAG_PREFIX}_project_${sha256(projectIdentity)}`,
    displayName: projectRoot,
    projectPath: projectRoot,
    projectName,
    gitRepoUrl: gitRepoUrl || undefined,
  };
}

/** 组合用户与项目标签，形状对齐 ProjectTags 与 contracts.ts TagsLike */
export function getTags(directory: string): {
  user: TagInfo;
  project: ProjectTagInfo;
} {
  const user = getUserTagInfo(directory);
  const project = getProjectTagInfo(directory);
  return {
    user,
    project: {
      tag: project.tag,
      displayName: project.displayName,
      projectPath: project.projectPath ?? directory,
      projectName: project.projectName ?? getProjectName(directory),
      gitRepoUrl: project.gitRepoUrl,
    },
  };
}
