// 注入过滤回归测试：混合块（用户文本 + system-reminder）必须保留用户文本
// 背景：旧实现按"包含 marker"整块丢弃，dsh 把 AGENTS.md 指引以 <system-reminder>
// 拼进用户消息 → 真实用户输入被误杀 → 自动捕获对真实会话永不生效。
import { describe, expect, it } from "vitest";
import {
  filterInjectedBlocks,
  stripInjectionSpans,
  isInjectedBlock,
} from "../src/services/injected-prompt-filter.js";

describe("stripInjectionSpans", () => {
  it("剥离成对 system-reminder 段，保留用户文本", () => {
    const text = "帮我修个 bug\n\n<system-reminder>\nInstructions from: ~/.dsh/AGENTS.md\nbalabalba\n</system-reminder>";
    expect(stripInjectionSpans(text)).toBe("帮我修个 bug");
  });

  it("多个成对标签全部剥离", () => {
    const text = "A<system-reminder>x</system-reminder>B<team_mode_status>y</team_mode_status>C";
    expect(stripInjectionSpans(text).replace(/\s+/g, "")).toBe("ABC");
  });
});

describe("filterInjectedBlocks", () => {
  it("混合块保留剥离后的用户文本", () => {
    const kept = filterInjectedBlocks([
      { type: "text", text: "真实输入\n<system-reminder>\n注入指引\n</system-reminder>" },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.text).toBe("真实输入");
  });

  it("纯注入块整块丢弃", () => {
    const kept = filterInjectedBlocks([
      { type: "text", text: "<system-reminder>\n只有注入内容\n</system-reminder>" },
    ]);
    expect(kept).toHaveLength(0);
  });

  it("未闭合的注入标记块丢弃", () => {
    const kept = filterInjectedBlocks([
      { type: "text", text: "<system-reminder>\nunclosed 注入" },
    ]);
    expect(kept).toHaveLength(0);
  });

  it("synthetic 标记块直接丢弃", () => {
    const kept = filterInjectedBlocks([
      { type: "text", text: "宿主注入的合成消息", synthetic: true },
      { type: "text", text: "用户输入" },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.text).toBe("用户输入");
  });

  it("行首独立注入标记整块丢弃", () => {
    expect(isInjectedBlock({ type: "text", text: "[Agent Usage Reminder] 提示内容" })).toBe(true);
  });

  it("普通文本原样保留", () => {
    const kept = filterInjectedBlocks([{ type: "text", text: "检查数据库状态" }]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.text).toBe("检查数据库状态");
  });
});
