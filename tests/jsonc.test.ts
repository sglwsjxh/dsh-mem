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
// jsonc 解析测试
import { describe, expect, it } from "vitest";
import { parseJsonc, stripJsoncComments } from "../src/services/jsonc.js";

describe("stripJsoncComments", () => {
  it("剥离行注释", () => {
    expect(stripJsoncComments('{\n  // 注释\n  "a": 1\n}')).toBe('{\n  \n  "a": 1\n}');
  });

  it("剥离块注释", () => {
    expect(stripJsoncComments('{ /* 块 */ "a": 1 }')).toBe('{  "a": 1 }');
  });

  it("字符串内的注释符不剥离", () => {
    const out = stripJsoncComments('{ "url": "http://x.com/a", "s": "/* not comment */" }');
    expect(JSON.parse(out)).toEqual({ url: "http://x.com/a", s: "/* not comment */" });
  });

  it("剥离尾逗号", () => {
    expect(JSON.parse(stripJsoncComments('{ "a": 1, "b": [1, 2,], }'))).toEqual({ a: 1, b: [1, 2] });
  });

  it("转义引号不破坏字符串状态", () => {
    const out = stripJsoncComments('{ "s": "a\\"b // c" }');
    expect(JSON.parse(out)).toEqual({ s: 'a"b // c' });
  });
});

describe("parseJsonc", () => {
  it("解析带注释的配置", () => {
    const content = `{
      // 数据目录
      "dataPath": "./data",
      "embedding": {
        "type": "modelscope", // 镜像
      },
    }`;
    expect(parseJsonc<{ dataPath: string; embedding: { type: string } }>(content)).toEqual({
      dataPath: "./data",
      embedding: { type: "modelscope" },
    });
  });
});
