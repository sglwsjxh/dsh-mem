// 画像学习：积累 userLearningCaptured=0 的 prompt 到阈值后 LLM 分析合并
// 改写自 opencode-mem user-memory-learning：去掉 opencode provider 分支
import { getConfig } from "../config.js";
import type { LlmClient, ProfilePreference, UserProfileData } from "../types.js";
import { utf8ByteLength } from "./context-limit.js";
import { resolveLanguageName } from "./language.js";
import { log } from "./logger.js";
import { userPromptStore, type UserPrompt } from "./user-prompt-store.js";
import type { TagsLike, UserProfileManagerLike } from "./contracts.js";

let isLearningRunning = false;

export interface ProfileLearningDeps {
  tags: TagsLike;
  llm: LlmClient;
  profileManager: UserProfileManagerLike;
}

export interface ProfileAnalysisResult {
  preferences: { category: string; description: string; confidence: number; evidence: string[] }[];
  patterns: { category: string; description: string }[];
  workflows: { description: string; steps: string[] }[];
}

const ANALYSIS_SYSTEM_PROMPT = `You are a user behavior analyst for a coding assistant.

Your task is to analyze user prompts and produce a user profile as JSON.

CRITICAL: All descriptions and categories must be written in the language specified below.
CRITICAL: All JSON string values MUST escape double quotes with backslash.

Reply with a single JSON object only:
{
  "preferences": [{"category": "...", "description": "...", "confidence": 0.3-0.5, "evidence": ["..."]}],
  "patterns": [{"category": "...", "description": "..."}],
  "workflows": [{"description": "...", "steps": ["step1", "step2", "step3"]}]
}

Rules:
- Preferences: code style, communication style, tool preferences, revealed choices. Confidence 0.3-0.5.
- Patterns: recurring topics, problem domains, technical interests.
- Workflows: distinct named step sequences (3-6 concrete steps). Only genuinely NEW recurring sequences.
- Only output observations grounded in the RECENT PROMPTS. Do NOT extract one-time debugging tasks, environment setup, or specific error investigations.`;

function buildUserAnalysisContext(prompts: UserPrompt[], existingProfile: UserProfileData | null): string {
  const maxBytes = getConfig().userProfileMaxContext ?? 32768;
  const sections: string[] = [`# User Profile Analysis`, ``, `Analyze ${prompts.length} user prompts to ${existingProfile ? "update" : "create"} the user profile.`, ``];

  if (existingProfile) {
    const prefCats = [...new Set(existingProfile.preferences.map((p) => p.category))];
    if (prefCats.length > 0) {
      sections.push(`## Existing Categories`, prefCats.join(", "), ``);
    }
  }

  sections.push(`## Recent Prompts`, ``, prompts.map((p, i) => `${i + 1}. ${p.content}`).join("\n\n"), ``);
  const guideline = ANALYSIS_SYSTEM_PROMPT.split("You are a user behavior analyst")[1]?.split("Reply with a single JSON object only:")[0]?.trim() ?? "";
  if (guideline) sections.push(guideline);
  sections.push(``, `Reply with the JSON object only.`);

  const base = sections.join("\n");
  if (utf8ByteLength(base) <= maxBytes) return base;
  return base.substring(0, maxBytes) + "\n[... context truncated to userProfileMaxContext ...]";
}

function parseAnalysisJson(text: string): ProfileAnalysisResult | null {
  let raw = text.trim();
  raw = raw.replace(/```json\s*/, "").replace(/```\s*$/, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as ProfileAnalysisResult & { validations?: unknown };
    if (!Array.isArray(parsed.preferences) || !Array.isArray(parsed.patterns) || !Array.isArray(parsed.workflows)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 内部进程互斥 + 阈值触发的画像学习主入口 */
export async function performUserProfileLearning(deps: ProfileLearningDeps): Promise<void> {
  const cfg = getConfig();
  if (isLearningRunning) return;
  if (!cfg.userProfileEnabled) return;

  isLearningRunning = true;
  try {
    const count = await userPromptStore.countUnanalyzedForUserLearning();
    const threshold = cfg.userProfileAnalysisInterval;
    if (count < threshold) return;

    const prompts = await userPromptStore.getPromptsForUserLearning(threshold);
    if (prompts.length === 0) return;

    const userId = deps.tags.user.userEmail ?? "unknown";
    const existingProfile = await deps.profileManager.getActiveProfile(userId);
    const existingData: UserProfileData | null = existingProfile ? JSON.parse(existingProfile.profileData) : null;

    const langName = resolveLanguageName(cfg.autoCaptureLanguage, prompts.map((p) => p.content).join("\n\n"));
    const context = buildUserAnalysisContext(prompts, existingData);
    const systemPrompt = `${ANALYSIS_SYSTEM_PROMPT.replace("in the language specified below", `in ${langName}`)}`;

    const response = await deps.llm.complete([{ role: "user", content: context }], systemPrompt);
    const analysis = parseAnalysisJson(response);
    if (!analysis) {
      log("profile-learning: unparsable LLM response, marking batch consumed");
      await userPromptStore.markMultipleAsUserLearningCaptured(prompts.map((p) => p.id));
      return;
    }

    const raw: UserProfileData = {
      preferences: analysis.preferences.map(
        (p): ProfilePreference => ({
          category: p.category ?? "general",
          description: p.description ?? "",
          confidence: clamp01(p.confidence),
          frequency: 1,
          evidence: (p.evidence ?? []).slice(0, 3),
          lastSeen: Date.now(),
        }),
      ),
      patterns: (analysis.patterns ?? []).map((p) => ({
        category: p.category ?? "general",
        description: p.description ?? "",
        confidence: 0.4,
        frequency: 1,
        evidence: [],
        lastSeen: Date.now(),
      })),
      workflows: (analysis.workflows ?? []).map((w) => ({
        category: "workflow",
        description: w.description ?? "",
        confidence: 0.4,
        frequency: 1,
        evidence: (w.steps ?? []) as string[],
        lastSeen: Date.now(),
      })),
    };

    if (existingProfile && existingData) {
      const merged = await deps.profileManager.mergeProfileData(existingData, raw, undefined, existingProfile.id);
      await deps.profileManager.updateProfile(existingProfile.id, merged, prompts.length, "profile learning merge");
    } else {
      await deps.profileManager.createProfile(userId, deps.tags.user.displayName ?? userId, deps.tags.user.userName ?? userId, deps.tags.user.userEmail ?? userId, raw, prompts.length);
    }
    await userPromptStore.markMultipleAsUserLearningCaptured(prompts.map((p) => p.id));
    log("profile-learning updated", { userId, count: prompts.length });
  } catch (error) {
    log("profile-learning aborted", { error: String(error) });
    throw error;
  } finally {
    isLearningRunning = false;
  }
}

function clamp01(value: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0.4;
  return Math.min(1, Math.max(0, value));
}

/** 供 memory 工具 profile 写路径使用的显式偏好写入 */
export async function mergeExplicitPreference(
  deps: ProfileLearningDeps,
  userId: string,
  description: string,
): Promise<"created" | "merged"> {
  const newPreference: ProfilePreference = {
    category: "explicit",
    description,
    confidence: 1.0,
    frequency: 1,
    evidence: ["manual-write"],
    lastSeen: Date.now(),
  };
  const existingProfile = await deps.profileManager.getActiveProfile(userId);
  if (existingProfile) {
    const existingData: UserProfileData = JSON.parse(existingProfile.profileData);
    const merged = await deps.profileManager.mergeProfileData(existingData, { preferences: [newPreference] }, undefined, existingProfile.id);
    await deps.profileManager.updateProfile(existingProfile.id, merged, 0, `Explicit preference added: ${description.slice(0, 80)}`);
    return "merged";
  }
  await deps.profileManager.createProfile(userId, userId, userId, userId, { preferences: [newPreference], patterns: [], workflows: [] }, 0);
  return "created";
}
