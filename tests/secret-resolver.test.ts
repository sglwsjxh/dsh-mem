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
// 密钥解析测试
import { describe, expect, it } from "vitest";
import { resolveSecretValue } from "../src/services/secret-resolver.js";

describe("resolveSecretValue", () => {
  it("明文原样返回", () => {
    expect(resolveSecretValue("sk-abc123")).toBe("sk-abc123");
  });

  it("空值返回 undefined", () => {
    expect(resolveSecretValue(undefined)).toBeUndefined();
    expect(resolveSecretValue("")).toBeUndefined();
    expect(resolveSecretValue("   ")).toBeUndefined();
  });

  it("env://NAME 从环境变量取值", () => {
    process.env.DSH_MEM_TEST_SECRET = "from-env";
    try {
      expect(resolveSecretValue("env://DSH_MEM_TEST_SECRET")).toBe("from-env");
    } finally {
      delete process.env.DSH_MEM_TEST_SECRET;
    }
  });

  it("env:// 缺失变量返回 undefined", () => {
    delete process.env.DSH_MEM_DEFINITELY_NOT_SET_XYZ;
    expect(resolveSecretValue("env://DSH_MEM_DEFINITELY_NOT_SET_XYZ")).toBeUndefined();
  });

  it("file://path 从文件取值并去首尾空白", async () => {
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "dsh-mem-test-"));
    const file = join(dir, "key.txt");
    writeFileSync(file, "  file-key\n");
    expect(resolveSecretValue(`file://${file}`)).toBe("file-key");
  });

  it("file:// 文件不存在返回 undefined", () => {
    expect(resolveSecretValue("file:///no/such/file/xyz.txt")).toBeUndefined();
  });
});
