// 就绪门：初始化分片注册表，0.1.0 无历史迁移负担
import { tursoShardManager } from "./shard-manager.js";

let initPromise: Promise<void> | null = null;
let isReady = false;

export async function ensureTursoReady(): Promise<void> {
  if (isReady) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      // 触发 metadata.db 建表，同时作为基础可用性检查
      await tursoShardManager.getAllShards("user", "");
      isReady = true;
    } catch (error) {
      initPromise = null;
      throw error;
    }
  })();

  return initPromise;
}

export function resetTursoReady(): void {
  isReady = false;
  initPromise = null;
}
