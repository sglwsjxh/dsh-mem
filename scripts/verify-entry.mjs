// 校验构建产物的 cordis 插件导出契约
// 背景：cordis 加载器 unwrapExports 见到 default 导出会只取它，丢掉 inject/name
// 该脚本在 CI 中拦截这类回归
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ENTRY = resolve(process.cwd(), "dist/index.mjs");

if (!existsSync(ENTRY)) {
  console.error(`✗ 构建产物不存在: ${ENTRY}（先运行 npm run build）`);
  process.exit(1);
}

const mod = await import(pathToFileURL(ENTRY).href);

// 复刻 cordis-plugin-loader 的 unwrapExports 语义
let resolved = mod;
if (resolved && resolved.default != null) resolved = resolved.default;

const errors = [];

if (resolved.default != null) {
  errors.push("产物含 default 导出：cordis 加载器会丢弃 inject/name，请移除 default");
}
if (!Array.isArray(resolved.inject)) {
  errors.push(`inject 不是数组（实际 ${typeof resolved.inject}）：插件依赖声明会失效`);
} else if (resolved.inject.length === 0) {
  errors.push("inject 为空数组：无法声明宿主服务依赖");
}
if (typeof resolved.apply !== "function") {
  errors.push(`apply 不是函数（实际 ${typeof resolved.apply}）：cordis 无法调用插件`);
}
if (typeof resolved.name !== "string" || resolved.name.trim() === "") {
  errors.push("name 缺失或为空：cordis 无法注册插件标识");
}

if (errors.length > 0) {
  console.error("✗ 插件导出契约校验失败:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log("✓ 插件导出契约校验通过");
console.log(`  name:   ${resolved.name}`);
console.log(`  inject: [${resolved.inject.join(", ")}]`);
console.log(`  apply:  ${typeof resolved.apply}`);
