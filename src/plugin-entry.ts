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

// 插件装配入口：构造 memoryClient 与 tags 与 llm 与 profileManager 交给内部 apply
// cordis 加载器规范：有 default 导出时只取 default，命名导出 inject 与 name 会被丢弃
// 因此只导出 name 与 inject 与 apply
import type { Context } from "@deepseek-ai/cordis";
import { initConfig } from "./config.js";
import { apply as applyPlugin, installPluginDeps, type DshMemPluginOptions } from "./plugin.js";
import { createLocalMemoryClient } from "./services/memory-client.js";
import { getTags } from "./services/tags.js";
import { createLlmClient } from "./services/llm-client.js";
import { getUserProfileManager } from "./services/user-profile-manager.js";
import { getEmbeddingService } from "./services/embedding.js";
import { log } from "./services/logger.js";

export { installPluginDeps } from "./plugin.js";
export { createMemoryTool } from "./tools/memory.js";
export { createLocalMemoryClient } from "./services/memory-client.js";
export { getUserProfileManager } from "./services/user-profile-manager.js";

/** 插件名，cordis 注册标识 */
export const name = "dsh-mem";

/** 声明的宿主服务依赖，未就绪时 cordis 不调用 apply */
export const inject = ["tools", "systemPrompt"];

/** cordis 函数插件入口，先装配依赖再交给内部 apply */
export function apply(ctx: Context, config?: DshMemPluginOptions): void {
  // 配置只读 ~/.dsh/dsh-mem.jsonc。initConfig 失败时已向 stderr 报错，这里静默跳过装配
  const cfg = initConfig();
  if (!cfg) return;

  const workspaceRoot = config?.workspaceRoot ?? process.cwd();
  const memoryClient = createLocalMemoryClient(getEmbeddingService(cfg.embedding));
  const tags = getTags(workspaceRoot);
  const llm = createLlmClient(cfg.llm);
  const profileManager = getUserProfileManager();

  installPluginDeps({ memoryClient, tags, llm, profileManager });
  applyPlugin(ctx, config);
}
