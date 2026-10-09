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

// dsh-mem 入口：cordis 函数插件
// 坑：不能有 default 导出。cordis 加载器见到 default 只取它，丢掉 inject 与 name
export { apply, name, inject, installPluginDeps, getUserProfileManager, createLocalMemoryClient, createMemoryTool } from "./plugin-entry.js";
export type { PluginDeps, DshMemPluginOptions } from "./plugin.js";
export { SessionTurnCollector, extractAuthoredUserText } from "./plugin.js";
export { performAutoCapture, buildMarkdownContext, getAutoCaptureMarkdownBudget } from "./services/auto-capture.js";
export { performUserProfileLearning, mergeExplicitPreference } from "./services/profile-learning.js";
export { formatContextForPrompt, formatProfileForContext } from "./services/context-format.js";
export { userPromptStore, UserPromptStore } from "./services/user-prompt-store.js";
export { UserProfileManager } from "./services/user-profile-manager.js";
export { stripPrivateContent, isFullyPrivate } from "./services/privacy.js";
export { initConfig, getConfig, isConfigured, resetConfig, CONFIG_PATH } from "./config.js";
export { getTags, getProjectTagInfo } from "./services/tags.js";
export { createLlmClient } from "./services/llm-client.js";
export { getEmbeddingService, resetEmbeddingService, EmbeddingService } from "./services/embedding.js";
export type * from "./types.js";
