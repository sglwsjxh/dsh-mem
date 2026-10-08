// 模型标识解析与本地定位：单一 model 字符串 → 具体可加载的模型位置
// 协议：openai 兼容名 / file://<path> / hf://<org>/<repo> / ms://<org>/<repo>
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelSource, ParsedModelRef } from "../types.js";

/** GGUF 文件名里的量化 tag（参考社区主流命名惯例，覆盖 UD-/K-quant/浮点系） */
const GGUF_QUANT_RE = /(?:UD-)?((?:IQ[0-9]+_[A-Z]+[A-Z0-9_]*|Q[0-9]+_K_[A-Z]+|Q[0-9]+_[0-9]+|Q[0-9]+_K|BF16|F16|F32))/i;

/** 量化偏好序（嵌入精度敏感：Q8_0 优先，其次大 K-quant，低 bit 靠后） */
const QUANT_PREFERENCE = [
  "Q8_0",
  "Q6_K",
  "Q5_K_M",
  "Q5_K_XL",
  "Q5_K_S",
  "Q4_K_XL",
  "Q4_K_M",
  "Q4_K_S",
  "BF16",
  "F16",
  "F32",
];

/** 解析结果：可直接加载的本地模型位置 */
export type ResolvedModel =
  | { kind: "onnx"; dir: string }
  | { kind: "gguf"; file: string };

/** 解析 model 字符串为结构化来源；无法识别的形态按远程 openai 兼容处理 */
export function parseModelRef(model: string): ParsedModelRef {
  const trimmed = model.trim();
  if (trimmed.startsWith("file://")) {
    return { source: { kind: "file", path: trimmed.slice(7) }, raw: trimmed };
  }
  const hfMatch = /^hf:\/\/([^/]+)\/(.+)$/.exec(trimmed);
  if (hfMatch) {
    return { source: { kind: "hf", org: hfMatch[1]!, repo: hfMatch[2]! }, raw: trimmed };
  }
  const msMatch = /^ms:\/\/([^/]+)\/(.+)$/.exec(trimmed);
  if (msMatch) {
    return { source: { kind: "ms", org: msMatch[1]!, repo: msMatch[2]! }, raw: trimmed };
  }
  return { source: { kind: "openai" }, raw: trimmed };
}

/** HF 缓存候选根（按序）：HF_HUB_CACHE > $HF_HOME/hub > ~/.cache/huggingface/hub */
export function hfCacheRoots(): string[] {
  const roots: string[] = [];
  if (process.env.HF_HUB_CACHE) roots.push(process.env.HF_HUB_CACHE);
  if (process.env.HF_HOME) roots.push(join(process.env.HF_HOME, "hub"));
  roots.push(join(homedir(), ".cache", "huggingface", "hub"));
  return [...new Set(roots)];
}

/** ModelScope 缓存候选根（按序，含新版 modelscope_hub 布局兼容） */
export function msCacheRoots(): string[] {
  const roots: string[] = [];
  if (process.env.MODELSCOPE_CACHE) roots.push(process.env.MODELSCOPE_CACHE);
  roots.push(join(homedir(), ".cache", "modelscope", "hub"), join(homedir(), ".cache", "modelscope"));
  return [...new Set(roots)];
}

function findFirstExistingDir(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (existsSync(p) && statSync(p).isDirectory()) return p;
    } catch {
      // 忽略不可访问路径
    }
  }
  return null;
}

/** 递归列目录下全部 .gguf 文件（不含 mmproj 附件） */
function listGgufFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.toLowerCase().endsWith(".gguf") && !entry.toLowerCase().includes("mmproj")) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/** 递归找 ONNX 模型目录：含 config.json 且目录里（或 onnx/ 子目录）有 .onnx 文件 */
function findOnnxDir(dir: string): string | null {
  const hasConfig = existsSync(join(dir, "config.json"));
  if (hasConfig) {
    const onnxDir = join(dir, "onnx");
    if (existsSync(onnxDir) && readdirSync(onnxDir).some((f) => f.toLowerCase().endsWith(".onnx"))) return dir;
    if (readdirSync(dir).some((f) => f.toLowerCase().endsWith(".onnx"))) return dir;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      if (statSync(full).isDirectory() && entry !== "onnx") {
        const found = findOnnxDir(full);
        if (found) return found;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** 按量化偏好从候选 .gguf 中选一个；单文件直接返回 */
export function pickGgufFile(files: string[]): string | null {
  if (files.length === 0) return null;
  if (files.length === 1) return files[0]!;
  const scored = files.map((file) => {
    const name = file.split(/[\\/]/).pop() ?? "";
    const match = GGUF_QUANT_RE.exec(name);
    const tag = match?.[1]?.toUpperCase() ?? "";
    const pref = QUANT_PREFERENCE.indexOf(tag);
    return { file, tag, rank: pref === -1 ? QUANT_PREFERENCE.length : pref };
  });
  scored.sort((a, b) => a.rank - b.rank || a.file.localeCompare(b.file));
  return scored[0]!.file;
}

/** 从 HF 缓存目录定位 models--{org}--{repo} 的最新 snapshot */
function resolveHfSnapshot(root: string, org: string, repo: string): string | null {
  const repoDir = join(root, `models--${org}--${repo}`);
  if (!existsSync(repoDir)) return null;
  const refsDir = join(repoDir, "refs");
  let commit: string | null = null;
  try {
    if (existsSync(refsDir)) {
      const refFile = join(refsDir, "main");
      if (existsSync(refFile)) commit = readFileSync(refFile, "utf-8").trim();
    }
  } catch {
    return null;
  }
  if (commit && existsSync(join(repoDir, "snapshots", commit))) {
    return join(repoDir, "snapshots", commit);
  }
  // refs 缺失时取字典序最大的 snapshot（最新 commit 近似）
  const snapshotsDir = join(repoDir, "snapshots");
  try {
    const commits = readdirSync(snapshotsDir).sort();
    if (commits.length > 0) return join(snapshotsDir, commits[commits.length - 1]!);
  } catch {
    return null;
  }
  return null;
}

/** 从 ModelScope 缓存目录定位 {org}/{repo}；兼容 models/ 前缀与直落布局 */
function resolveMsRepoDir(root: string, org: string, repo: string): string | null {
  const candidates = [join(root, "models", org, repo), join(root, org, repo)];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** 在缓存里探测模型；返回 null 表示未命中（需要下载） */
export function findCachedModel(source: ModelSource): ResolvedModel | null {
  if (source.kind === "hf") {
    const root = findFirstExistingDir(hfCacheRoots());
    if (!root) return null;
    const snapshot = resolveHfSnapshot(root, source.org, source.repo);
    if (!snapshot) return null;
    const ggufs = listGgufFiles(snapshot);
    if (ggufs.length > 0) {
      const file = pickGgufFile(ggufs);
      return file ? { kind: "gguf", file } : null;
    }
    const onnxDir = findOnnxDir(snapshot);
    return onnxDir ? { kind: "onnx", dir: onnxDir } : null;
  }

  if (source.kind === "ms") {
    const root = findFirstExistingDir(msCacheRoots());
    if (!root) return null;
    const repoDir = resolveMsRepoDir(root, source.org, source.repo);
    if (!repoDir) return null;
    const ggufs = listGgufFiles(repoDir);
    if (ggufs.length > 0) {
      const file = pickGgufFile(ggufs);
      return file ? { kind: "gguf", file } : null;
    }
    const onnxDir = findOnnxDir(repoDir);
    return onnxDir ? { kind: "onnx", dir: onnxDir } : null;
  }

  return null;
}

/** file:// 路径的本地定位：.gguf 文件 / 含 onnx 的目录 / 报错 */
export function resolveFileModel(path: string): ResolvedModel {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`file:// 模型路径不存在: ${resolved}`);
  }
  if (statSync(resolved).isFile()) {
    if (resolved.toLowerCase().endsWith(".gguf")) {
      return { kind: "gguf", file: resolved };
    }
    if (resolved.toLowerCase().endsWith(".safetensors")) {
      throw new Error(
        `不支持 safetensors 直载（纯权重容器，Node 无成熟运行时）: ${resolved}\n请改用含 config.json + onnx/*.onnx 的 ONNX 目录，或 .gguf 文件（HF/MS 上的社区 ONNX/GGUF 转换版均可）`
      );
    }
    throw new Error(`file:// 指向的文件不是 .gguf: ${resolved}`);
  }
  const ggufs = listGgufFiles(resolved);
  if (ggufs.length > 0) {
    const file = pickGgufFile(ggufs);
    if (file) return { kind: "gguf", file };
  }
  const onnxDir = findOnnxDir(resolved);
  if (onnxDir) return { kind: "onnx", dir: onnxDir };
  throw new Error(
    `file:// 目录里既没有 .gguf 也没有可用 ONNX 模型（需要 config.json + onnx/*.onnx）: ${resolved}`
  );
}

/**
 * 统一入口：model 字符串 → 可加载的本地模型位置。
 * 远程 openai 形态不在此处理（调用方按 kind==="openai" 分派）。
 * 缓存未命中的下载由调用方（embedding-local）在 warmup 时触发。
 */
export function resolveModelLocation(
  ref: ParsedModelRef,
  ensureDownloaded: (source: ModelSource) => Promise<void>
): Promise<ResolvedModel> {
  if (ref.source.kind === "file") {
    return Promise.resolve(resolveFileModel(ref.source.path));
  }
  const cached = findCachedModel(ref.source);
  if (cached) return Promise.resolve(cached);
  return ensureDownloaded(ref.source).then(() => {
    const after = findCachedModel(ref.source);
    if (after) return after;
    throw new Error(`模型下载完成但缓存中仍未找到: ${ref.raw}`);
  });
}
