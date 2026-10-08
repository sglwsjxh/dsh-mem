// 插件装配入口：构造 memoryClient / tags / llm / profileManager 并交给内部 apply
// cordis 加载器规范（cordis-plugin-loader unwrapExports）：
//   有 default 导出时只取 default，命名导出（inject/name）会被一并丢弃
//   因此不导出 default，只导出 { name, inject, apply } 命名导出
import type { Context } from "@deepseek-ai/cordis";
import { initConfig, isConfigured } from "./config.js";
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

/** 插件名（cordis 注册标识） */
export const name = "dsh-mem";

/** 声明的宿主服务依赖：未就绪时 cordis 不调用 apply */
export const inject = ["tools", "systemPrompt"];

/**
 * cordis 函数插件入口：先装配依赖，再交给内部 apply。
 * cordis 以 (ctx, config) 调用；config 可带 workspaceRoot。
 */
export function apply(ctx: Context, config?: DshMemPluginOptions): void {
  const cfg = initConfig(config?.workspaceRoot);
  if (!isConfigured()) {
    log("dsh-mem skipped: config incomplete (set embedding.model and llm.model in config.jsonc)");
    return;
  }

  const workspaceRoot = config?.workspaceRoot ?? process.cwd();
  const memoryClient = createLocalMemoryClient(getEmbeddingService());
  const tags = getTags(workspaceRoot);
  const llm = createLlmClient(cfg.llm);
  const profileManager = getUserProfileManager();

  installPluginDeps({ memoryClient, tags, llm, profileManager });
  applyPlugin(ctx, config);
}
