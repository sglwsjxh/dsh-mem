# dsh-mem

DeepSeek Harness (dsh) 持久记忆插件，用本地向量数据库给编码智能体长期项目记忆：`memory` 工具、自动对话捕获、新会话记忆注入、用户画像学习

## 环境要求

- Node.js >= 22.19
- dsh >= 0.2.0-rc.1
- Windows：VC++ 2015+ 运行库（@tursodatabase/database 需要）

## 安装

```powershell
dsh plugin --profile web add @sglwsjxh/dsh-mem@latest
```

## 源码克隆

```powershell
git clone https://github.com/sglwsjxh/dsh-mem.git
cd dsh-mem
dsh plugin --profile web add .
```

然后复制示例配置并修改：

```powershell
cp config.jsonc.example ~/.dsh/dsh-mem.jsonc
```

## 配置

```jsonc
{
  "datapath": "./data",
  "embedding": {
    "model": "nvidia/nemotron-3-embed-1b:free",
    "baseurl": "https://openrouter.ai/api/v1",
    "apikey": "YOUR_API_KEY",
    "dimensions": 2048
  },
  "llm": {
    "platform": "openai",   // openai | anthropic | gemini
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-4o-mini",
    "apiKey": "env://OPENAI_API_KEY"
  }
}
```

- 嵌入只走 OpenAI 兼容 /v1/embeddings 端点；本地模型（GGUF、ONNX）请自行启动 OpenAI 兼容服务（如 llama-server --embedding），baseurl 填 http://127.0.0.1:8080/v1 这类地址
- dimensions 可选：填了直接透传给 API，不做本地截断与探测
- datapath 相对路径相对 ~/.dsh 解析；向量数据、prompt 存储、画像全在里面
- apiKey 支持 env://NAME、file:///path、明文三种格式

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

scope 取值 project（默认，工作区项目）或 all（跨全部项目 + user 分片）

任何入库内容里的 <private>…</private> 区段会先脱敏；整段私有的内容拒绝存储

## 许可证

[AGPL-3.0-only](./LICENSE)
