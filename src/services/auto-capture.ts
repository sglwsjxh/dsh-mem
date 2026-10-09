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

// 自动捕获：会话空闲后取未捕获 prompt，LLM 总结入库
import { randomUUID } from "node:crypto";
import { getConfig } from "../config.js";
import type { CaptureSummary, LlmClient, MemorySearchResult } from "../types.js";
import { utf8ByteLength, truncateToMaxBytes } from "./context-limit.js";
import { isInternalSummaryPrompt } from "./injected-prompt-filter.js";
import { log } from "./logger.js";
import { userPromptStore, type UserPrompt } from "./user-prompt-store.js";
import type { MemoryClientLike, TagsLike } from "./contracts.js";
const RETRY_BASE_DELAY_MS = 2000;
const DEFAULT_MAX_CONTEXT_BYTES = 131072;
const CONTEXT_TRUNCATION_MARKER = "\n[... truncated to autoCaptureMaxContext ...]\n";
const SUMMARY_REQUEST_OVERHEAD_BYTES = 1024;
const SUMMARY_OUTPUT_RESERVE_BYTES = 16384;
const SUMMARY_ANALYSIS_SUFFIX =
  "Analyze this conversation. If it contains technical work (code, bugs, features, decisions), " +
  'create a concise summary and relevant tags. If it\'s non-technical (greetings, casual chat, incomplete requests), return type="skip" with empty summary.';

// 会话间串行化，避免并发捕获互相丢任务
let captureChain: Promise<void> = Promise.resolve();

export interface AutoCaptureDeps {
  memoryClient: MemoryClientLike;
  tags: TagsLike;
  llm: LlmClient;
}

export interface PerformAutoCaptureOptions {
  signal?: AbortSignal;
  /** 本轮新增的助手响应，宿主回调采集 */
  sessionContext: SessionContext;
}

/** 一次会话的对话上下文 */
export interface SessionContext {
  sessionId: string;
  /** 用户输入，已过滤注入内容 */
  userPrompts: string[];
  assistantResponses: string[];
  toolCalls: { name: string; input: string }[];
}

export async function performAutoCapture(deps: AutoCaptureDeps, options: PerformAutoCaptureOptions): Promise<void> {
  const run = async () => {
    if (options.signal?.aborted) return;
    await runAutoCapture(deps, options);
  };
  const next = captureChain.then(run, run);
  captureChain = next.catch(() => {});
  return next;
}

/** dispose 前等待在途捕获结束 */
export function awaitCaptureDrain(): Promise<void> {
  return captureChain;
}

async function runAutoCapture(deps: AutoCaptureDeps, options: PerformAutoCaptureOptions): Promise<void> {
  const cfg = getConfig();
  const { sessionContext } = options;
  const prompts = await userPromptStore.getUncapturedPromptsForSession(sessionContext.sessionId);
  if (prompts.length === 0) return;

  const maxRetries = cfg.autoCaptureMaxRetries;
  for (const prompt of prompts) {
    await capturePrompt(deps, prompt, maxRetries, options);
  }
}

async function capturePrompt(
  deps: AutoCaptureDeps,
  prompt: UserPrompt,
  maxRetries: number,
  options: PerformAutoCaptureOptions,
): Promise<void> {
  const cfg = getConfig();
  let claimed = false;
  let attempt = prompt.captureAttempts;

  try {
    claimed = await userPromptStore.claimPrompt(prompt.id);
    if (!claimed) return;

    while (attempt < maxRetries) {
      attempt++;
      try {
        const tags = deps.tags;
        const latestMemory = await getLatestProjectMemory(deps.memoryClient, tags.project.tag);
        const context = buildMarkdownContext(
          prompt.content,
          options.sessionContext.assistantResponses,
          options.sessionContext.toolCalls,
          latestMemory,
          getAutoCaptureMarkdownBudget(),
        );

        const summary = await generateSummary(deps, context, prompt.content);

        if (!summary || summary.type === "skip") {
          log("auto-capture skipped", { promptId: prompt.id, type: summary?.type });
          await userPromptStore.deletePrompt(prompt.id);
          claimed = false;
          return;
        }

        const summaryWithTags =
          summary.tags.length > 0 ? `${summary.summary}\n\nTags: ${summary.tags.join(", ")}` : summary.summary;

        const projectMeta = tags.project as typeof tags.project & { userName?: string; userEmail?: string };
        const result = await deps.memoryClient.addMemory(summaryWithTags, tags.project.tag, {
          type: summary.type,
          tags: summary.tags,
          sessionId: prompt.sessionId,
          promptId: prompt.id,
          captureTimestamp: Date.now(),
          displayName: projectMeta.displayName,
          userName: projectMeta.userName,
          userEmail: projectMeta.userEmail,
          projectPath: tags.project.projectPath,
          projectName: tags.project.projectName,
          gitRepoUrl: tags.project.gitRepoUrl,
        });

        if (result.success) {
          claimed = false;
          // 记忆已落库，状态更新失败不能进重试分支，否则重复写记忆
          try {
            await userPromptStore.markCapturedWithMemory(prompt.id, String(result.id));
            log("auto-capture memory persisted", { promptId: prompt.id, memoryId: String(result.id) });
          } catch (statusError) {
            log("auto-capture status update failed (memory already persisted)", {
              promptId: prompt.id,
              memoryId: String(result.id),
              error: String(statusError),
            });
          }
          return;
        }
        throw new Error(`memory persistence failed: ${result.error ?? "database write failed"}`);
      } catch (error) {
        await userPromptStore.recordFailedAttempt(prompt.id);
        if (attempt < maxRetries) {
          log(`auto-capture warning (attempt ${attempt}/${maxRetries})`, { error: String(error) });
          await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)));
        } else {
          throw error;
        }
      }
    }
  } catch (error) {
    log(`auto-capture final error after ${attempt} attempts`, { error: String(error) });
  } finally {
    if (claimed) {
      try {
        await userPromptStore.releaseClaim(prompt.id);
      } catch (releaseError) {
        log("failed to release claim", { promptId: prompt.id, error: String(releaseError) });
      }
    }
  }
}

async function getLatestProjectMemory(memoryClient: MemoryClientLike, containerTag: string): Promise<string | null> {
  try {
    const result = await memoryClient.listMemories(containerTag, 1);
    if (!result.success || result.memories.length === 0) return null;
    const latest = result.memories[0];
    if (!latest) return null;
    const content = typeof latest.content === "string" ? latest.content : "";
    if (content.length <= 500) return content;
    return content.substring(0, 500) + "...";
  } catch {
    return null;
  }
}

function fitTextResponses(textResponses: string[], maxBytes: number): string {
  if (textResponses.length === 0 || maxBytes <= 0) return "";
  const separator = "\n\n";
  const separatorBytes = utf8ByteLength(separator);
  const joined = textResponses.join(separator);
  if (utf8ByteLength(joined) <= maxBytes) return joined;

  const kept: string[] = [];
  let usedBytes = 0;
  for (let i = textResponses.length - 1; i >= 0; i--) {
    const response = textResponses[i] ?? "";
    const responseBytes = utf8ByteLength(response);
    const extraSeparator = kept.length > 0 ? separatorBytes : 0;
    const needed = responseBytes + extraSeparator;
    if (usedBytes + needed <= maxBytes) {
      kept.unshift(response);
      usedBytes += needed;
      continue;
    }
    const remaining = maxBytes - usedBytes - extraSeparator;
    if (remaining > utf8ByteLength(CONTEXT_TRUNCATION_MARKER)) {
      kept.unshift(truncateToMaxBytes(response, remaining, CONTEXT_TRUNCATION_MARKER));
    }
    break;
  }
  return kept.join(separator);
}

function joinSections(sections: string[]): string {
  return sections.join("\n");
}

export function getAutoCaptureMarkdownBudget(totalRequestBytes: number = DEFAULT_MAX_CONTEXT_BYTES): number {
  const requestReserve = Math.min(24576, Math.floor(totalRequestBytes * 0.25));
  return Math.max(4096, totalRequestBytes - requestReserve);
}

/** 组装捕获上下文，体积受 autoCaptureMaxContext 约束 */
export function buildMarkdownContext(
  userPrompt: string,
  textResponses: string[],
  toolCalls: { name: string; input: string }[],
  latestMemory: string | null,
  maxContextBytes: number = getConfig().autoCaptureMaxContext ?? DEFAULT_MAX_CONTEXT_BYTES,
): string {
  const memorySections: string[] = [];
  if (latestMemory) {
    memorySections.push("## Previous Memory Context", "---", latestMemory, "---\n");
  }

  const toolsSections: string[] = [];
  if (toolCalls.length > 0) {
    toolsSections.push("## Tools Used", "---");
    for (const tool of toolCalls) {
      toolsSections.push(tool.input ? `- ${tool.name}(${tool.input})` : `- ${tool.name}`);
    }
    toolsSections.push("---\n");
  }

  const aiWrapper = textResponses.length > 0 ? ["## AI Response", "---", "", "---\n"] : ([] as string[]);

  const skeletonWithoutBodies = joinSections([...memorySections, ...["## User Request", "---", "", "---\n"], ...aiWrapper, ...toolsSections]);
  const skeletonBytes = utf8ByteLength(skeletonWithoutBodies);

  let userBudget = Math.max(0, maxContextBytes - skeletonBytes);
  if (textResponses.length > 0 && userBudget > 1024) {
    const preferredAiFloor = Math.min(4096, Math.floor(maxContextBytes * 0.25));
    userBudget = Math.max(256, userBudget - preferredAiFloor);
  }

  const boundedUser = utf8ByteLength(userPrompt) <= userBudget ? userPrompt : truncateToMaxBytes(userPrompt, userBudget, CONTEXT_TRUNCATION_MARKER);

  const prefix = joinSections([...memorySections, "## User Request", "---", boundedUser, "---\n", ...toolsSections]);

  if (textResponses.length === 0) {
    if (utf8ByteLength(prefix) <= maxContextBytes) return prefix;
    return truncateToMaxBytes(prefix, maxContextBytes, CONTEXT_TRUNCATION_MARKER);
  }

  const prefixWithoutTools = joinSections([...memorySections, "## User Request", "---", boundedUser, "---\n"]);
  const toolsBlock = toolsSections.length > 0 ? "\n" + joinSections(toolsSections) : "";
  const aiWrapperBytes = utf8ByteLength(joinSections(["## AI Response", "---", "", "---\n"]));
  const aiBudget = Math.max(0, maxContextBytes - utf8ByteLength(prefixWithoutTools) - utf8ByteLength(toolsBlock) - aiWrapperBytes);
  const boundedAi = fitTextResponses(textResponses, aiBudget);

  const result = joinSections([...memorySections, "## User Request", "---", boundedUser, "---\n", "## AI Response", "---", boundedAi, "---\n", ...toolsSections]);

  if (utf8ByteLength(result) <= maxContextBytes) return result;
  return truncateToMaxBytes(result, maxContextBytes, CONTEXT_TRUNCATION_MARKER);
}

/** 总结 prompt 体积约束 */
export function buildBoundedSummaryPrompt(
  context: string,
  systemPrompt: string,
  schemaJson: string,
  totalRequestBytes: number = getConfig().autoCaptureMaxContext ?? DEFAULT_MAX_CONTEXT_BYTES,
): string {
  const schemaBytes = utf8ByteLength(schemaJson);
  const outputReserve = Math.min(SUMMARY_OUTPUT_RESERVE_BYTES, Math.floor(totalRequestBytes * 0.125));
  const userBudget = Math.max(0, totalRequestBytes - utf8ByteLength(systemPrompt) - schemaBytes - outputReserve - SUMMARY_REQUEST_OVERHEAD_BYTES);
  return truncateToMaxBytes(`${context}\n\n${SUMMARY_ANALYSIS_SUFFIX}`, userBudget, CONTEXT_TRUNCATION_MARKER);
}

function buildCaptureSystemPrompt(): string {
  return `You are a technical memory recorder for a software development project.

RULES:
1. ONLY capture technical work (code, bugs, features, architecture, config)
2. SKIP non-technical by returning type="skip"
3. NO meta-commentary or behavior analysis
4. Include specific file names, functions, technical details
5. Generate 2-4 technical tags (e.g., "react", "auth", "bug-fix")
6. You MUST write the summary in the same language as the user input.

FORMAT:
## Request
[1-2 sentences: what was requested]

## Outcome
[1-2 sentences: what was done, include files/functions]

SKIP if: greetings, casual chat, no code/decisions made
CAPTURE if: code changed, bug fixed, feature added, decision made

You must reply with a single JSON object only:
{"summary": "...", "type": "feature|bug-fix|refactor|analysis|configuration|discussion|skip|other", "tags": ["tag1", "tag2"]}`;
}

const SUMMARY_JSON_PREFIX = /```json\s*/;
const SUMMARY_JSON_SUFFIX = /```\s*$/;

function parseSummaryJson(text: unknown): CaptureSummary | null {
  // LLM 可能返回非字符串，统一兜底避免崩溃
  if (typeof text !== "string") {
    if (Array.isArray(text)) text = text.filter((t) => typeof t === "string").join("\n");
    else if (text && typeof text === "object") text = JSON.stringify(text);
    else return null;
  }
  let raw = String(text).trim();
  raw = raw.replace(SUMMARY_JSON_PREFIX, "").replace(SUMMARY_JSON_SUFFIX, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { summary?: unknown; type?: unknown; tags?: unknown };
    if (typeof parsed.summary !== "string" || typeof parsed.type !== "string") return null;
    const tags = Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === "string") : [];
    return {
      summary: parsed.summary,
      type: parsed.type,
      tags: tags.map((t) => t.toLowerCase().trim()),
    };
  } catch {
    return null;
  }
}

async function generateSummary(deps: AutoCaptureDeps, context: string, userPrompt: string): Promise<CaptureSummary | null> {
  // 语言由 LLM 跟随用户输入，不做本地检测
  void userPrompt;
  const systemPrompt = buildCaptureSystemPrompt();
  const aiPrompt = buildBoundedSummaryPrompt(context, systemPrompt, '{"summary":"...","type":"...","tags":["..."]}');

  const response = await deps.llm.complete([{ role: "user", content: aiPrompt }], systemPrompt);
  const parsed = parseSummaryJson(response);
  if (!parsed) throw new Error("summary generation returned unparsable response");
  if (isInternalSummaryPrompt(parsed.summary)) return null;
  return parsed;
}

/** 生成工具调用摘要，入参截断 */
export function summarizeToolCall(name: string, input: unknown, maxLength = 100): { name: string; input: string } {
  let inputText = "";
  if (typeof input === "string") {
    inputText = input;
  } else if (input && typeof input === "object") {
    const params: string[] = [];
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      params.push(`${key}: ${JSON.stringify(value)}`);
    }
    inputText = params.join(", ");
  }
  if (inputText.length > maxLength) inputText = inputText.substring(0, maxLength) + "...";
  return { name, input: inputText };
}

/** 内部测试用：捕获会话 id */
export function newCaptureSessionId(promptId: string): string {
  return `auto-capture-${promptId}-${randomUUID()}`;
}

// 兼容旧引用名
export type { MemorySearchResult };
