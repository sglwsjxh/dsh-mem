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
// 隐私脱敏单测：<private> 区域改写规则
import { describe, it, expect } from "vitest";
import { stripPrivateContent, isFullyPrivate } from "../src/services/privacy.js";

describe("stripPrivateContent", () => {
  it("无标签文本原样返回", () => {
    expect(stripPrivateContent("hello world")).toBe("hello world");
  });

  it("简单区域替换为 REDACTED", () => {
    expect(stripPrivateContent("a <private>secret</private> b")).toBe("a [REDACTED] b");
  });

  it("嵌套标签在外层收口", () => {
    expect(stripPrivateContent("x <private>a <private>b</private> c</private> y")).toBe("x [REDACTED] y");
  });

  it("未闭合标签脱敏到末尾", () => {
    expect(stripPrivateContent("x <private>oops")).toBe("x [REDACTED]");
  });

  it("孤立闭合标签被丢弃", () => {
    expect(stripPrivateContent("a </private> b")).toBe("a  b");
  });

  it("忽略大小写与标签内空白", () => {
    expect(stripPrivateContent("a <PRIVATE >x</PRIVATE> b")).toBe("a [REDACTED] b");
  });

  it("多个独立区域各自替换", () => {
    expect(stripPrivateContent("<private>a</private>-<private>b</private>")).toBe("[REDACTED]-[REDACTED]");
  });
});

describe("isFullyPrivate", () => {
  it("纯 REDACTED 为真", () => {
    expect(isFullyPrivate("<private>all secret</private>")).toBe(true);
  });

  it("空串为真", () => {
    expect(isFullyPrivate("")).toBe(true);
  });

  it("有剩余内容为假", () => {
    expect(isFullyPrivate("visible <private>hidden</private>")).toBe(false);
  });
});
