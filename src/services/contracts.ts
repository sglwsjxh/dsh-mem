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

// 宿主集成层接口占位，core 落地后按同签名替换
import type { MemoryRecord, MemorySearchResult, ProjectTags, UserProfileRecord, UserProfileData } from "../types.js";

/** 存储客户端最小接口 */
export interface MemoryClientLike {
  warmup(): Promise<void>;
  isReady(): boolean;
  getEmbeddingInitError(): string | null;
  ensureStorageReady(): Promise<void>;
  addMemory(
    content: string,
    containerTag: string,
    metadata?: {
      type?: string;
      source?: "manual" | "auto-capture" | "import" | "api";
      tags?: string[];
      sessionId?: string;
      promptId?: string;
      captureTimestamp?: number;
      displayName?: string;
      userName?: string;
      userEmail?: string;
      projectPath?: string;
      projectName?: string;
      gitRepoUrl?: string;
      [key: string]: unknown;
    },
  ): Promise<{ success: boolean; id?: string; error?: string }>;
  searchMemories(
    query: string,
    containerTag: string,
    scope: "project" | "all",
  ): Promise<{ success: boolean; results: MemorySearchResult[]; error?: string }>;
  listMemories(
    containerTag: string,
    limit: number,
    scope?: "project" | "all",
  ): Promise<{ success: boolean; memories: MemoryRecord[]; error?: string }>;
  deleteMemory(memoryId: string): Promise<{ success: boolean; error?: string }>;
  searchMemoriesBySessionID(
    sessionId: string,
    containerTag: string,
    limit: number,
  ): Promise<{ success: boolean; results: MemorySearchResult[]; error?: string }>;
  close(): Promise<void>;
}

/** getTags 返回形状 */
export interface TagsLike {
  user: ProjectTags["user"];
  project: ProjectTags["project"];
}

/** 画像管理器最小接口 */
export interface UserProfileManagerLike {
  getActiveProfile(userId: string): Promise<UserProfileRecord | null>;
  createProfile(
    userId: string,
    displayName: string,
    userName: string,
    userEmail: string,
    data: UserProfileData,
    analyzedCount: number,
  ): Promise<void>;
  updateProfile(profileId: string, data: UserProfileData, analyzedCount: number, summary: string): Promise<boolean>;
  mergeProfileData(
    existing: UserProfileData,
    incoming: Partial<UserProfileData>,
    _undefined?: undefined,
    profileId?: string,
  ): Promise<UserProfileData>;
}

export function tagsLikeFromProjectTags(tags: ProjectTags): TagsLike {
  return tags;
}
