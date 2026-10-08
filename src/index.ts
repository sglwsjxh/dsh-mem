// dsh-mem 入口：cordis 函数插件（name / inject / apply 命名导出）
// 注意：不能有 default 导出——cordis 加载器见到 default 会只取它，丢掉 inject/name
export { apply, name, inject, installPluginDeps, getUserProfileManager, createLocalMemoryClient, createMemoryTool } from "./plugin-entry.js";
export type { PluginDeps, DshMemPluginOptions } from "./plugin.js";
export { SessionTurnCollector, extractAuthoredUserText } from "./plugin.js";
export { performAutoCapture, buildMarkdownContext, getAutoCaptureMarkdownBudget } from "./services/auto-capture.js";
export { performUserProfileLearning, mergeExplicitPreference } from "./services/profile-learning.js";
export { formatContextForPrompt, formatProfileForContext } from "./services/context-format.js";
export { userPromptStore, UserPromptStore } from "./services/user-prompt-store.js";
export { UserProfileManager } from "./services/user-profile-manager.js";
export { stripPrivateContent, isFullyPrivate } from "./services/privacy.js";
export { detectLanguage, getLanguageName } from "./services/language.js";
export { initConfig, getConfig, isConfigured, resetConfig } from "./config.js";
export { getTags, getProjectTagInfo } from "./services/tags.js";
export { createLlmClient } from "./services/llm-client.js";
export { parseModelRef, findCachedModel, resolveFileModel, resolveModelLocation, pickGgufFile } from "./services/model-resolve.js";
export { getEmbeddingService, resetEmbeddingService } from "./services/embedding.js";
export type * from "./types.js";
