# dsh-mem

DeepSeek Harness (dsh) persistent-memory plugin, ported from [tickernelz/opencode-mem](https://github.com/tickernelz/opencode-mem). Gives coding agents long-term project memory backed by a local vector database: a `memory` tool, automatic conversation capture, memory injection into new sessions, and user-profile learning

## Requirements

- Node.js >= 22.19
- dsh >= 0.2.0-rc.1
- Windows: VC++ 2015+ Redistributable (needed by `@tursodatabase/database`)

## Install

```powershell
dsh plugin --profile web add "link:C:/path/to/dsh-mem"
```

Then copy the example config and edit it:

```powershell
cp config.jsonc.example ~/.dsh/dsh-mem.jsonc
```

This is the only config path ever read; if the file is missing or unparsable the plugin prints an error to stderr and skips loading

## Configure

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

- Embeddings only call an OpenAI-compatible `/v1/embeddings` endpoint; for local models (GGUF, ONNX) start your own OpenAI-compatible server (e.g. `llama-server --embedding`) and point `baseurl` at `http://127.0.0.1:8080/v1`
- `dimensions` is optional: when set it is passed straight through to the API, with no local truncation or probing
- A relative `datapath` resolves against `~/.dsh`; vector data, the prompt store, and profiles all live there
- `apiKey` accepts `env://NAME`, `file:///path`, or a literal

## Use

No manual steps needed — memory builds up as you work:

1. Restart dsh after installing; the plugin registers the `memory` tool
2. Work normally; when a turn ends (10 s debounce) auto-capture summarizes technical work through the configured `llm` and stores it
3. New sessions get relevant memories + your user profile injected as `<memory_context>`
4. Ask the agent to use the `memory` tool directly:

```text
memory({ mode: "add", content: "project uses pnpm workspaces", tags: "build" })
memory({ mode: "search", query: "build setup" })
memory({ mode: "search", query: "architecture", scope: "all" })
memory({ mode: "profile" })
memory({ mode: "list", limit: 10 })
memory({ mode: "forget", memoryId: "mem_..." })
memory({ mode: "list-shards" })
memory({ mode: "migrate", fromPath: "/old/project/path" })
memory({ mode: "export", outputPath: "./memories.json" })
memory({ mode: "import", inputPath: "./memories.json" })
```

`scope` is `project` (default, the workspace project) or `all` (across all projects + the user shard)

`<private>…</private>` spans in any stored content are redacted before persisting; fully private content is refused

## License

[AGPL-3.0-only](./LICENSE)
