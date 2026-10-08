# dsh-mem

DeepSeek Harness (dsh) persistent-memory plugin, ported from [tickernelz/opencode-mem](https://github.com/tickernelz/opencode-mem). Gives coding agents long-term project memory backed by a local vector database: a `memory` tool for the agent, automatic conversation capture, memory injection into new sessions, user-profile learning, and local vector search — with no external services.

## Requirements

- Node.js >= 22.19
- dsh >= 0.2.0-rc.1
- Embedding backend — one `embedding.model` string decides (see Configure):
  - remote: any OpenAI-compatible `/v1/embeddings` endpoint
  - `file://` — a local ONNX model directory or `.gguf` file
  - `hf://` / `ms://` — auto-resolved from the local HF/ModelScope cache, auto-download on miss (requires [uv](https://docs.astral.sh/uv/) on PATH for the MS path: `winget install astral-sh.uv`)
- Windows: VC++ 2015+ Redistributable (needed by `@tursodatabase/database` and `onnxruntime-node`)

## Install

```powershell
dsh plugin --profile web add "link:C:/path/to/dsh-mem"
```

Then copy the example config and edit it:

```powershell
cp config.json.example config.jsonc
```

`config.jsonc` is loaded from the dsh workspace root first; `~/.dsh/dsh-mem.jsonc` is the fallback. Every field is commented in the example file.

## Configure

The `embedding.model` string decides everything:

```jsonc
{
  "datapath": "./data",
  "embedding": {
    // remote OpenAI-compatible (model name without a scheme prefix)
    "model": "nvidia/nemotron-3-embed-1b:free",
    "baseurl": "https://openrouter.ai/api/v1",
    "apikey": "YOUR_API_KEY",
    "dimensions": 2048

    // local ONNX directory or .gguf file
    // "model": "file://./models/google/embeddinggemma-2"

    // Hugging Face — checks the local HF cache first (HF_HUB_CACHE /
    // HF_HOME/hub / ~/.cache/huggingface/hub), auto-downloads on miss
    // "model": "hf://onnx-community/embeddinggemma-2-ONNX"

    // ModelScope — checks the local MS cache first
    // (MODELSCOPE_CACHE / ~/.cache/modelscope/hub), auto-downloads on miss
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

- `dimensions` is optional: when omitted, the actual output dimension is detected on first embed and persisted to `{datapath}/meta.json`
- GGUF quantization is picked automatically (single file → use it; multiple → filename quantization tag, Q8_0 preferred)
- `apikey` accepts `env://NAME`, `file:///path`, or a literal
- Local runtimes: directories containing `config.json` + `onnx/*.onnx` load through transformers.js (ONNX); `.gguf` files load through node-llama-cpp; `.safetensors` is not supported (weights-only container, no runtime in Node — use an ONNX or GGUF variant)
- Vector data, prompt store, profiles, and the dimension cache all live under `datapath` (default `./data`)

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

`scope` is `project` (default, from config) or `all` (across all projects + user shard).

`<private>…</private>` spans in any stored content are redacted before persisting; fully private content is refused.

## Differences from opencode-mem

- Embedding model is a single `model` string with four schemes (remote / `file://` / `hf://` / `ms://`) instead of separate type+path fields; GGUF quantization and output dimensions are auto-detected instead of configured
- Memory scope is `project | all` instead of `project | all-projects`
- The internal LLM is configured directly (`platform`/`baseUrl`/`model`/`apiKey`) instead of reusing the host's provider session
- Memory injection rides dsh's native `systemPrompt.context` instead of synthetic chat parts
- Web UI, auto-update, and multimodal embeddings are not in this release (planned)

## Known limitations

- First model download needs network access; on failure the error message prints the exact command to run manually
- GGUF runtime requires node-llama-cpp >= a release that bundles llama.cpp with the `gemma-embedding2` architecture (merged 2026-10-06); v3.22.1 fails with `unknown architecture` — use the ONNX runtime for EmbeddingGemma-2 until then
- Embeddings are not comparable across models or `dimensions` changes; shards record the model string and refuse mismatched writes
- Windows keeps the vector DB single-process (Turso engine limitation)

## License

[AGPL-3.0-only](./LICENSE)
