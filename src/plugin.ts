// dsh-mem 宿主插件：cordis 函数插件 (ctx, config)
// 职责：注册 memory 工具、监听 session 事件（捕获 prompt / 触发自动捕获）、systemPrompt.context 注入记忆
import type { Context } from "@deepseek-ai/cordis";
import type { UserMessage } from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { getConfig } from "./config.js";
import type { MemoryClientLike, TagsLike, UserProfileManagerLike } from "./services/contracts.js";
import type { LlmClient } from "./types.js";
import { awaitCaptureDrain, performAutoCapture, summarizeToolCall, type SessionContext } from "./services/auto-capture.js";
import { formatContextForPrompt } from "./services/context-format.js";
import { extractTextBlocks, filterInjectedBlocks, isInternalSummaryPrompt } from "./services/injected-prompt-filter.js";
import { log } from "./services/logger.js";
import { performUserProfileLearning } from "./services/profile-learning.js";
import { getTags } from "./services/tags.js";
import { userPromptStore } from "./services/user-prompt-store.js";
import { createMemoryTool } from "./tools/memory.js";

/** 插件装配依赖：core/engine 模块交付后由入口注入实现 */
export interface PluginDeps {
  memoryClient: MemoryClientLike;
  tags: TagsLike;
  llm: LlmClient;
  profileManager: UserProfileManagerLike;
}

interface UserMessageText {
  id: string;
  sessionId: string;
  text: string;
}

/** 从 UserMessage 提取已过滤的用户文本；空返回 null（注入消息/空消息） */
export function extractAuthoredUserText(message: UserMessage): string | null {
  const blocks = extractTextBlocks(message.content);
  const authored = filterInjectedBlocks(blocks);
  if (authored.length === 0) return null;
  const text = authored.map((b) => b.text).join("\n").trim();
  if (!text) return null;
  if (isInternalSummaryPrompt(text)) return null;
  return text;
}

/** 从 session 事件流采集一次 turn 的助手响应/工具调用，供自动捕获 */
export class SessionTurnCollector {
  private turns = new Map<string, SessionContext>();
  private readonly maxTurns = 64;

  /** 记录用户 prompt（capture 用） */
  beginTurn(sessionId: string, userText: string): void {
    const ctx = this.turns.get(sessionId) ?? { sessionId, userPrompts: [], assistantResponses: [], toolCalls: [] };
    ctx.userPrompts.push(userText);
    this.turns.set(sessionId, ctx);
    this.evictOldest();
  }

  recordAssistantText(sessionId: string, text: string): void {
    const ctx = this.turns.get(sessionId);
    if (!ctx) return;
    ctx.assistantResponses.push(text);
  }

  recordToolCall(sessionId: string, name: string, input: unknown): void {
    const ctx = this.turns.get(sessionId);
    if (!ctx) return;
    ctx.toolCalls.push(summarizeToolCall(name, input));
  }

  take(sessionId: string): SessionContext {
    const ctx = this.turns.get(sessionId) ?? { sessionId, userPrompts: [], assistantResponses: [], toolCalls: [] };
    this.turns.delete(sessionId);
    return ctx;
  }

  private evictOldest(): void {
    if (this.turns.size <= this.maxTurns) return;
    const firstKey = this.turns.keys().next().value;
    if (firstKey !== undefined) this.turns.delete(firstKey);
  }
}

/** 从 tool/call 事件参数解析工具输入 */
function parseToolArguments(rawArguments: string): unknown {
  try {
    return JSON.parse(rawArguments) as unknown;
  } catch {
    return rawArguments;
  }
}

/** 从 assistant/message 事件提取文本 */
function extractAssistantText(event: SessionEvent): string | null {
  if (event.type !== "assistant/message") return null;
  const blocks = event.data.message.content;
  const texts: string[] = [];
  for (const block of blocks) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) texts.push(text.trim());
    }
  }
  if (texts.length === 0) return null;
  return texts.join("\n");
}

export interface DshMemPluginOptions {
  /** 工作区目录（project tag 依据） */
  workspaceRoot?: string;
}

/**
 * dsh-mem cordis 插件入口。
 * cordis 函数插件签名 (ctx, config)；config 透传 workspaceRoot。
 */
export function apply(ctx: Context, config?: DshMemPluginOptions): void {
  // 配置已在 plugin-entry.initConfig() 成功加载（只读 ~/.dsh/dsh-mem.jsonc）；
  // 直接取 getConfig()，未初始化会抛错暴露装配顺序问题
  const cfg = getConfig();
  const workspaceRoot = config?.workspaceRoot ?? process.cwd();

  const deps = resolvePluginDeps(ctx);
  const lifetime = new AbortController();
  const collector = new SessionTurnCollector();
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 待捕获的轮次上下文：防抖期间累积，避免密集对话丢上下文 */
  const pendingContexts = new Map<string, SessionContext>();
  /** 最近活跃会话 id：注入时用于排除本会话刚写入的记忆（防自引用） */
  let currentSessionId: string | undefined;
  /** 会话真实工作区（session.header.cwd）：项目身份跟随它，而非进程 cwd */
  let currentWorkspace: string | undefined;
  /** 按目录缓存的 tags：同一目录只算一次 sha256/git 探测 */
  const tagsCache = new Map<string, TagsLike>();
  let disposed = false;

  /**
   * 活跃 tags：优先会话工作区，其次装配时目录，最后进程 cwd。
   * 项目身份必须跟 dsh 会话走——宿主可能从任意目录启动，cwd 不可信。
   * overrideDirectory 供工具执行时精确指定（exec 携带的会话 cwd）。
   */
  function getActiveTags(overrideDirectory?: string): TagsLike {
    const dir = overrideDirectory ?? currentWorkspace ?? workspaceRoot;
    const cached = tagsCache.get(dir);
    if (cached) return cached;
    const resolved = getTags(dir);
    tagsCache.set(dir, resolved);
    return resolved;
  }

  /**
   * 活跃工作区目录：与 getActiveTags 同源（会话工作区优先）。
   * 可携性模式与注入都依赖它，避免认成装配目录。
   */
  function getActiveDirectory(overrideDirectory?: string): string {
    return overrideDirectory ?? currentWorkspace ?? workspaceRoot;
  }

  // ---- memory 工具 ----
  const memoryTool = createMemoryTool({
    memoryClient: deps.memoryClient,
    tags: deps.tags,
    getActiveTags: (overrideDirectory) => getActiveTags(overrideDirectory),
    getActiveDirectory: (overrideDirectory) => getActiveDirectory(overrideDirectory),
    profileManager: deps.profileManager,
    directory: workspaceRoot,
  });
  const disposeTool = ctx.tools.register(memoryTool);

  // ---- 会话事件监听 ----
  const disposeSessionListener = ctx.on("session/event", (session, event) => {
    if (disposed) return;
    // 会话工作区：header.cwd 是会话创建时记录的绝对路径，比进程 cwd 可靠
    const ws = (session as { header?: { cwd?: string } }).header?.cwd;
    if (ws) currentWorkspace = ws;
    // 诊断：确认事件真的进来了（含 cwd 与事件类型），便于排查捕获不触发
    log("session/event 收到", {
      sessionId: session.id,
      type: (event as { type?: string }).type,
      cwd: ws ?? "(none)",
    });
    try {
      handleSessionEvent(session.id, event);
    } catch (error) {
      log("session/event handler error", { error: String(error) });
    }
  });

  function handleSessionEvent(sessionId: string, event: SessionEvent): void {
    if (event.type === "user/message") {
      currentSessionId = sessionId;
      // payload 即 UserMessage 本身；只捕获直接人类输入（source.kind === 'user'）
      const source = event.data.source as { kind?: string } | undefined;
      if (source?.kind !== "user") {
        // 诊断：非人类输入被过滤（注入消息/子代理 prompt/内部总结），记录 kind 便于排查
        log("skip user/message: not authored", { sessionId, kind: source?.kind ?? "(none)" });
        return;
      }
      if (!cfg.injectEnabled && !cfg.autoCaptureEnabled) return;
      const authored = extractAuthoredUserText(event.data);
      if (!authored) {
        log("skip user/message: empty after filter", { sessionId });
        return;
      }
      collector.beginTurn(sessionId, authored);
      if (cfg.autoCaptureEnabled) {
        const activeTags = getActiveTags();
        void userPromptStore
          .savePrompt(sessionId, event.data.id, activeTags.project.projectPath ?? workspaceRoot, authored)
          .then((promptId) => log("prompt saved", { sessionId, promptId }))
          .catch((error) => log("savePrompt failed", { error: String(error) }));
      }
      return;
    }

    if (event.type === "assistant/message") {
      const text = extractAssistantText(event);
      if (text) collector.recordAssistantText(sessionId, text);
      return;
    }

    if (event.type === "tool/call") {
      collector.recordToolCall(sessionId, event.data.name, parseToolArguments(event.data.arguments));
      return;
    }

    if (event.type === "turn/end" && event.data.reason.kind === "completed") {
      if (!cfg.autoCaptureEnabled) return;
      const sessionContext = collector.take(sessionId);
      if (sessionContext.userPrompts.length === 0) return;

      // 10s 空闲防抖：同会话的连续轮次合并成一次捕获。
      // 注意必须累积上下文——早期实现直接 take 后丢弃，密集对话（轮次间隔 < 10s）
      // 会让定时器不断重置、已取的上下文被丢掉，导致捕获永不触发。
      const pending = pendingContexts.get(sessionId);
      if (pending) {
        // 密集对话时合并本轮上下文，避免 take() 后丢弃导致捕获永不触发
        pending.userPrompts.push(...sessionContext.userPrompts);
        pending.assistantResponses.push(...sessionContext.assistantResponses);
        pending.toolCalls.push(...sessionContext.toolCalls);
      } else {
        pendingContexts.set(sessionId, sessionContext);
      }
      const existingTimer = idleTimers.get(sessionId);
      if (existingTimer) clearTimeout(existingTimer);
      const timer = setTimeout(() => {
        try {
          idleTimers.delete(sessionId);
          const merged = pendingContexts.get(sessionId);
          pendingContexts.delete(sessionId);
          if (!merged) return;
          void runIdleCapture(sessionId, merged);
        } catch (error) {
          log("idle capture error", { error: String(error) });
        }
      }, 10000);
      idleTimers.set(sessionId, timer);
      if (disposed) {
        clearTimeout(timer);
        idleTimers.delete(sessionId);
        pendingContexts.delete(sessionId);
      }
    }
  }

  async function runIdleCapture(sessionId: string, sessionContext: SessionContext): Promise<void> {
    if (disposed) return;
    const activeTags = getActiveTags();
    try {
      await performAutoCapture(
        { memoryClient: deps.memoryClient, tags: activeTags, llm: deps.llm },
        { signal: lifetime.signal, sessionContext },
      );
      if (disposed) return;
      await performUserProfileLearning({ tags: activeTags, llm: deps.llm, profileManager: deps.profileManager });
    } catch (error) {
      log("idle processing error", { error: String(error) });
    }
  }

  // ---- systemPrompt.context 注入 ----
  let cachedContext = "";
  let cachedAt = 0;
  const CONTEXT_CACHE_TTL_MS = 30000;

  const disposeContext = ctx.systemPrompt.context({
    name: "dsh-mem:memory-context",
    order: 400,
    text: (assembleCtx) => {
      if (!cfg.injectEnabled || disposed) return "";
      if (assembleCtx.signal?.aborted) return "";
      // 同步返回空：首次调用先登记异步刷新，下一轮装配生效
      const now = Date.now();
      if (now - cachedAt > CONTEXT_CACHE_TTL_MS) {
        void refreshMemoryContext();
      }
      return cachedContext;
    },
  });

  async function refreshMemoryContext(): Promise<void> {
    if (disposed) return;
    try {
      await deps.memoryClient.ensureStorageReady();
      const activeTags = getActiveTags();
      const listResult = await deps.memoryClient.listMemories(activeTags.project.tag, cfg.injectMaxMemories);
      if (!listResult.success) {
        log("memory context list failed", { error: listResult.error });
        return;
      }
      let memories = listResult.memories;
      // 排除当前会话产生的记忆：避免把本会话刚存的内容又注入回来（自引用）
      if (cfg.injectExcludeCurrentSession && currentSessionId) {
        memories = memories.filter((m) => {
          const meta = m.metadata as { sessionID?: unknown } | undefined;
          const sid = typeof meta?.sessionID === "string" ? meta.sessionID : undefined;
          return sid !== currentSessionId;
        });
      }
      if (cfg.injectMaxAgeDays) {
        const cutoff = Date.now() - cfg.injectMaxAgeDays * 86400000;
        memories = memories.filter((m) => m.createdAt > cutoff);
      }
      if (memories.length === 0) {
        cachedContext = "";
        cachedAt = Date.now();
        return;
      }
      const userId = activeTags.user.userEmail ?? null;
      const context = await formatContextForPrompt(
        userId,
        {
          results: memories.map((m) => ({ similarity: 1.0, memory: m.content })),
        },
        (uid) => loadProfileData(deps.profileManager, uid),
      );
      cachedContext = context;
      cachedAt = Date.now();
    } catch (error) {
      log("refreshMemoryContext failed", { error: String(error) });
    }
  }

  // ---- dispose ----
  ctx.effect(() => {
    return async () => {
      disposed = true;
      lifetime.abort();
      for (const timer of idleTimers.values()) clearTimeout(timer);
      idleTimers.clear();
      pendingContexts.clear();
      tagsCache.clear();
      disposeContext();
      disposeSessionListener();
      disposeTool();
      try {
        await awaitCaptureDrain();
      } catch {
        // 排空失败不阻塞卸载
      }
      try {
        await deps.memoryClient.close();
      } catch (error) {
        log("memoryClient close failed", { error: String(error) });
      }
      try {
        await userPromptStore.close();
      } catch {
        // 已在 close 内记录
      }
    };
  }, "dsh-mem:dispose");

  log("dsh-mem plugin started", {
    workspace: workspaceRoot,
    projectTag: getActiveTags().project.tag,
    autoCapture: cfg.autoCaptureEnabled,
    inject: cfg.injectEnabled,
  });
}

async function loadProfileData(profileManager: UserProfileManagerLike, userId: string | null): Promise<import("./types.js").UserProfileData | null> {
  if (!userId) return null;
  try {
    const profile = await profileManager.getActiveProfile(userId);
    if (!profile) return null;
    return JSON.parse(profile.profileData) as import("./types.js").UserProfileData;
  } catch {
    return null;
  }
}

/**
 * 解析插件依赖。core/engine 模块落地后从这里 import 实现单例；
 * 目前从全局符号取（宿主装配入口注入），取不到时插件按未装配降级。
 */
function resolvePluginDeps(_ctx: Context): PluginDeps {
  const key = Symbol.for("dsh-mem.plugin.deps") as unknown as string;
  const deps = (globalThis as unknown as Record<string, PluginDeps | undefined>)[key];
  if (!deps) {
    throw new Error("dsh-mem plugin deps not installed; call installPluginDeps() before apply()");
  }
  return deps;
}

/** 宿主装配入口：在 apply 前注入实现（core/engine 落地后由 index.ts 调用） */
export function installPluginDeps(deps: PluginDeps): void {
  const key = Symbol.for("dsh-mem.plugin.deps") as unknown as string;
  (globalThis as unknown as Record<string, PluginDeps | undefined>)[key] = deps;
}

export type { UserMessageText };
