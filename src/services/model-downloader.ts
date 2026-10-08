// 模型下载兜底：只负责驱动 uvx 子进程把仓库拉进对应缓存/目录
// 定位与选择逻辑在 model-resolve.ts；本模块不含任何模型 id 硬编码
import { spawn } from "node:child_process";
import type { ModelSource } from "../types.js";

const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const OUTPUT_CAP = 4000;

/** 构造 uvx 参数：modelscope 走 modelscope CLI（进 MS 默认缓存）；hf 走 hf CLI */
export function buildUvxArgs(source: ModelSource, repo: string, localDir?: string): string[] {
  if (source.kind === "ms") {
    const args = ["--from", "modelscope-hub", "modelscope", "download", repo];
    if (localDir) args.push("--local-dir", localDir);
    return args;
  }
  const args = ["--from", "huggingface_hub[cli]", "hf", "download", repo];
  if (localDir) args.push("--local-dir", localDir);
  return args;
}

/** 错误信息里附完整命令行，方便用户手跑 */
export function formatCommand(args: readonly string[]): string {
  return ["uvx", ...args].map(quoteForDisplay).join(" ");
}

function quoteForDisplay(arg: string): string {
  if (/[\s[\]]/.test(arg)) return `"${arg}"`;
  return arg;
}

function runUvxOnce(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("uvx", [...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`下载超时 (${DOWNLOAD_TIMEOUT_MS}ms): ${formatCommand(args)}`));
    }, DOWNLOAD_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk.toString("utf-8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (error.code === "ENOENT") {
        reject(new Error(`uvx 不可用，请先安装 uv（winget install astral-sh.uv 或 pip install uv）: ${formatCommand(args)}`));
        return;
      }
      reject(error);
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolvePromise();
        return;
      }
      const tail = (stderr || stdout).slice(-OUTPUT_CAP);
      reject(new Error(`下载失败 (exit ${code}): ${formatCommand(args)}\n${tail}`));
    });
  });
}

async function runUvxWithRetry(args: readonly string[]): Promise<void> {
  try {
    await runUvxOnce(args);
    return;
  } catch (first) {
    const firstMsg = first instanceof Error ? first.message : String(first);
    // uvx 缺失属于环境问题，重试无意义
    if (firstMsg.includes("uvx 不可用")) throw first;
    try {
      await runUvxOnce(args);
    } catch (second) {
      const secondMsg = second instanceof Error ? second.message : String(second);
      throw new Error(`重试后仍失败，请手动执行: ${formatCommand(args)}\n${secondMsg}`, { cause: second });
    }
  }
}

/**
 * 缓存未命中时的下载入口：
 * - ms://org/repo → modelscope download（进 MS 默认缓存，受 MODELSCOPE_CACHE 影响）
 * - hf://org/repo → hf download（默认进 HF 缓存；ONNX 场景一般由 transformers.js 自管下载，这里仅作兜底）
 * 下载后由调用方重新探测缓存。
 */
export async function downloadToCache(source: ModelSource, repoId: string): Promise<void> {
  if (source.kind !== "hf" && source.kind !== "ms") {
    throw new Error(`downloadToCache 仅支持 hf/ms 来源，收到: ${source.kind}`);
  }
  await runUvxWithRetry(buildUvxArgs(source, repoId));
}
