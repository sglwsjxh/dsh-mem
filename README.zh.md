# dsh-mem

DeepSeek Harness (dsh) 持久记忆插件，复刻自 [tickernelz/opencode-mem](https://github.com/tickernelz/opencode-mem)。用本地向量数据库给编码智能体长期项目记忆：`memory` 工具、自动对话捕获、新会话记忆注入、用户画像学习、本地向量搜索——全程无需外部服务。

## 环境要求

- Node.js >= 22.19
- dsh >= 0.2.0-rc.1
- 嵌入后端 —— 一个 embedding.model 字符串决定（见配置）：
  - 远程：任意 OpenAI 兼容 /v1/embeddings 端点
  - file:// —— 本地 ONNX 模型目录或 .gguf 文件
  - hf:// / ms:// —— 先查本地 HF/ModelScope 缓存，未命中自动下载（MS 路径需要 PATH 里有 uv：winget install astral-sh.uv）
- Windows：VC++ 2015+ 运行库（@tursodatabase/database 与 onnxruntime-node 需要）

## 安装

```powershell
dsh plugin --profile web add "link:C:/path/to/dsh-mem"
```

然后复制示例配置并修改：

```powershell
cp config.json.example config.jsonc
```

config.jsonc 优先从 dsh 工作区根目录读取，回退到 ~/.dsh/dsh-mem.jsonc。每个字段在示例文件里都有注释。

## 配置

embedding.model 一个字符串决定一切：

```jsonc
{
  "datapath": "./data",
  "embedding": {
    // 远程 OpenAI 兼容（不带前缀的模型名）
    "model": "nvidia/nemotron-3-embed-1b:free",
    "baseurl": "https://openrouter.ai/api/v1",
    "apikey": "YOUR_API_KEY",
    "dimensions": 2048

    // 本地 ONNX 目录或 .gguf 文件
    // "model": "file://./models/google/embeddinggemma-2"

    // Hugging Face —— 先查本地 HF 缓存（HF_HUB_CACHE / HF_HOME/hub /
    // ~/.cache/huggingface/hub），未命中自动下载
    // "model": "hf://onnx-community/embeddinggemma-2-ONNX"

    // ModelScope —— 先查本地 MS 缓存（MODELSCOPE_CACHE /
    // ~/.cache/modelscope/hub），未命中自动下载
    // "model": "ms://onnx-community/embeddinggemma-2-ONNX"
  },
  "llm": {
    "platform": "openai",   // openai | anthropic | gemini
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "apiKey": "env://OPENAI_API_KEY"
  }
}
```

- dimensions 可选：不填时首次 embed 自动探测实际维度，持久化到 {datapath}/meta.json
- GGUF 量化自动选择（单文件直接用；多文件按文件名量化 tag，Q8_0 优先）
- apiKey 支持 env://NAME、file:///path、明文三种格式
- 本地运行时：含 config.json + onnx/*.onnx 的目录走 transformers.js（ONNX）；.gguf 文件走 node-llama-cpp；不支持 .safetensors（纯权重容器，Node 无成熟运行时——请用 ONNX 或 GGUF 变体）
- 向量数据、prompt 存储、画像、维度缓存全部在 datapath 下（默认 ./data）

## 使用

无需手动操作，记忆随使用自然积累：

1. 安装后重启 dsh，插件注册 memory 工具
2. 正常干活，轮次结束（10s 防抖）后自动捕获把技术工作总结（走配置的 llm）存入
3. 新会话开头自动注入相关记忆与用户画像（memory_context）
4. 也可以直接让智能体调用 memory 工具：

```text
memory({ mode: "add", content: "项目用 pnpm workspaces", tags: "build" })
memory({ mode: "search", query: "构建配置" })
memory({ mode: "search", query: "架构决策", scope: "all" })
memory({ mode: "profile" })
memory({ mode: "list", limit: 10 })
memory({ mode: "forget", memoryId: "mem_..." })
memory({ mode: "list-shards" })
memory({ mode: "migrate", fromPath: "/old/project/path" })
memory({ mode: "export", outputPath: "./memories.json" })
memory({ mode: "import", inputPath: "./memories.json" })
```

scope 取值 project（默认，走配置）或 all（跨全部项目 + user 分片）。

任何入库内容里的 <private>…</private> 区段会先脱敏；整段私有的内容拒绝存储。

## 与 opencode-mem 的差异

- 嵌入模型是单一 model 字符串四种协议（远程 / file:// / hf:// / ms://），替代旧的 type+path 字段组合；GGUF 量化与输出维度自动探测而非配置
- 记忆 scope 是 project | all，替代旧的 project | all-projects
- 内部 LLM 直接配置（platform/baseUrl/model/apiKey），不复用宿主会话的 provider
- 记忆注入走 dsh 原生 systemPrompt.context，不注入合成消息
- Web UI、自动更新、多模态嵌入不在本版本（计划中）

## 已知限制

- 首次模型下载需要联网；失败时错误信息附带完整命令行可手动执行
- GGUF 运行时要求 node-llama-cpp 的发布版包含 gemma-embedding2 架构支持（2026-10-06 合入 llama.cpp 主线）；v3.22.1 会报 unknown architecture——在那之前 EmbeddingGemma-2 请用 ONNX 运行时
- 不同模型或不同 dimensions 之间的向量不可比；分片记录模型字符串，不匹配的写入直接拒绝
- Windows 上向量库单进程（Turso 引擎限制）

## 许可证

[AGPL-3.0-only](./LICENSE)
