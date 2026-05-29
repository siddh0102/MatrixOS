# MatrixOS

**A local-first desktop app for building, running, and orchestrating AI agents.**

Configure agents (model, instructions, tools, memory), chat with them, chain them
into multi-step **workflows**, run them on a **schedule**, and watch everything in
a built-in **observability** dashboard — across multiple AI providers, with your
API keys kept in the OS keychain (never in the app's UI layer).

> Built with Tauri 2 (Rust) + React 19 / TypeScript. Your data and keys stay on
> your machine.

---

## Features

- **Agents** — saved configs: provider/model, system prompt, tools, skills,
  sandbox, tool-approval policy, thinking mode, and delegation.
- **Chat** — multi-tab conversations with live token streaming, tool calls,
  reasoning, delegation, and cited memory sources.
- **Workflows** — a visual DAG editor (agent tasks, conditions, parallel, human
  input, transforms, tool calls, sub-workflows) with a live run trace.
- **Orchestrator pattern** — agents can delegate sub-tasks to other agents.
- **Memory** — episodic recall, document RAG, procedural templates, and knowledge
  bases; opt-in per agent, powered by a local vector store.
- **Observability** — per-turn / per-round / per-tool telemetry, cost estimates,
  failure breakdowns, a tool inspector, call replay, and optional OpenTelemetry
  export + alert rules.
- **Scheduling** — run agents on a cron schedule, even headless in the background.
- **Tools & integrations** — sandboxed filesystem, web fetch, Tavily web search,
  shell, and **MCP** servers for pluggable external tools.
- **Multi-provider** — OpenRouter / Groq / other OpenAI-compatible APIs, Anthropic
  Claude, Ollama, and local `llama.cpp`.

## Tech stack

| Layer | Tech |
|---|---|
| Shell | Tauri 2 |
| Frontend | React 19, TypeScript, TanStack Router, Zustand, React Flow |
| Backend | Rust (LLM transport/SSE, filesystem, scheduler, keychain) |
| Storage | SQLite (`tauri-plugin-sql` + `rusqlite`) |
| Vector search | sqlite-vec |
| Embeddings | local (transformers.js) / Ollama / OpenAI-compatible |

## Architecture at a glance

A React/TypeScript renderer owns the UI and orchestration; a Rust backend owns
HTTP egress, the OS keychain, and the databases. **API keys never cross to the
renderer** — it only learns whether a key is set.

Full design + diagrams: **[docs/MatrixOS-Architecture.md](docs/MatrixOS-Architecture.md)**.

## Getting started

### Prerequisites
- **Node.js** 18+
- **Rust** (stable toolchain) + your platform's Tauri build dependencies — see
  the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/).

### Run (development)
```bash
npm install
npm run tauri dev
```

### Build (production)
```bash
npm run tauri build
```

### Windows installer certificate warning

When running the `.exe` installer, Windows may display a security warning about an unsigned application. This is expected as I have not signed the code with X509 certificate yet. To proceed:

1. Click **"More info"** on the warning dialog.
2. Select **"Run anyway"** to install MatrixOS.

Your data and API keys remain secure — they're stored locally in the OS keychain, never transmitted during installation.

### First launch
1. **Settings → Providers** → add a provider and paste its API key (stored
   securely in your OS keychain).
2. Click **Test Connection**, pick a default model.
3. (Optional) Add a **Tavily** key under **Settings → General → Observability**
   for web search.
4. Go to **Agents** to use a built-in agent or create your own.

Full walkthrough of every screen: **[docs/user_guide.md](docs/user_guide.md)**.

## Project structure

```
src/                 React/TS renderer
  components/        views (chat, agents, workflows, dashboard, knowledge, …)
  agents/            agent runtime (executeAgentTurn)
  orchestration/     workflow executor, event bus, alerts, OTel bridge
  memory/            episodic / semantic (RAG) / procedural + stores
  tools/             tool registry + built-in tools
  providers/         provider proxy to the Rust backend
src-tauri/           Rust backend
  src/ipc/           Tauri commands (llm, fs, search, audit, mcp, scheduler…)
  src/providers/     provider transport (SSE, keychain, rate limit)
  migrations/        SQLite schema (v1 … v20)
docs/                architecture + user guide
```

## Scripts

| Command | Does |
|---|---|
| `npm run tauri dev` | Run the desktop app in dev |
| `npm run tauri build` | Build a production bundle |
| `npm run build` | Type-check + build the frontend |
| `npm test` | Run the test suite (Vitest) |
| `npm run lint` / `npm run format` | ESLint / Prettier |

## Security

API keys (providers, Tavily, MCP) are stored in the **OS keychain** and never
returned to the UI. Local databases (`*.db`) and debug dumps live in the app's
data directory and are git-ignored.

## License

[MIT](LICENSE) © Siddhartha Tiwari
