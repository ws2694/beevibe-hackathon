# Provider Integration Plan

Four external providers power the Beevibe Everywhere hackathon demo. This document captures the API surface, integration patterns, and key decisions for each.

---

## 1. Composio — Work Tool Actions

**Role:** Connects agents to real work apps (Gmail, Slack, Notion, Linear, GitHub, HubSpot, Calendar, 1000+ more) via managed OAuth and action execution.

### Packages

```bash
pnpm add @composio/core @composio/anthropic
# @composio/openai  if we ever swap provider
```

`@composio/core` is the primary SDK. Provider packages (`@composio/anthropic`, `@composio/openai`) wrap raw tools into the shape each LLM SDK expects. Current stable: `@composio/core@0.10.0`.

### Initialization

```typescript
import { Composio } from '@composio/core';
import { AnthropicProvider } from '@composio/anthropic';

const composio = new Composio({
  apiKey: process.env.COMPOSIO_API_KEY,
  provider: new AnthropicProvider({ cacheTools: true }),
  toolkitVersions: {
    github: '20250909_00',
    slack:  '20250902_00',
    // pin all toolkits we use — required for tools.execute()
  },
});
```

> **Important:** without a pinned `toolkitVersions` entry, `tools.execute()` throws `ComposioToolVersionRequiredError` unless `dangerouslySkipVersionCheck: true` is passed. Pin everything used in production.

### Connecting a User Account

```typescript
// Redirect-based OAuth (Gmail, Slack, etc.)
const req = await composio.connectedAccounts.link(userId, authConfigId);
// redirect user to req.redirectUrl, then:
const account = await req.waitForConnection();

// API-key auth (GitHub PAT, Linear API key, etc.)
const req = await composio.connectedAccounts.initiate(userId, authConfigId, {
  config: AuthScheme.APIKey({ api_key: userKey }),
});
```

`userId` is our internal agent/user ID. Composio scopes all connected accounts and tool calls to it.

### Getting Tools for an LLM Call

```typescript
// Returns AnthropicTool[] — pass directly to messages.create({ tools })
const tools = await composio.tools.get(userId, {
  toolkits: ['gmail', 'slack'],
  limit: 20,
});
```

Filter options: `{ tools: ['SLACK_SEND_MESSAGE'] }`, `{ search: 'create issue' }`, `{ tags: ['crm'] }`.

### Executing a Tool

```typescript
const result = await composio.tools.execute('GITHUB_CREATE_ISSUE', {
  userId,
  version: '20250909_00',
  arguments: { owner: 'beevibe-ai', repo: 'beevibe', title: 'Bug: ...' },
});
// result: { data, error, successful, logId }
```

### MCP Server (for Claude Code integration)

```typescript
const server = await composio.mcp.create('beevibe-actions', {
  toolkits: ['github', 'slack', 'gmail'],
});
const instance = await composio.mcp.generate(userId, server.id);
// instance.MCPUrl → SSE URL for Claude/Cursor MCP config
```

### Triggers (Webhooks)

```typescript
composio.triggers.subscribe((data) => { /* route to agent */ }, {
  toolkits: ['github'],
  triggerSlug: ['GITHUB_PULL_REQUEST_OPENED'],
});
```

### Key Environment Variables

| Variable | Purpose |
|---|---|
| `COMPOSIO_API_KEY` | Required — API key |
| `COMPOSIO_TOOLKIT_VERSION_GITHUB` | Pin per-toolkit version |
| `COMPOSIO_WEBHOOK_SECRET` | Trigger webhook signature verification |

### Error Types to Handle

- `ComposioToolVersionRequiredError` — missing version pin
- `ComposioConnectedAccountNotFoundError` — user hasn't connected the app
- `RateLimitError` (HTTP 429) — client has `maxRetries: 2` by default

### Integration Notes for Beevibe

- One `Composio` instance per agent type (one for Claude agents, one if we add OpenAI agents)
- `userId` maps to our `agent.id` in the database; Composio uses it to scope credentials
- Auth config IDs are stable — create once in Composio dashboard, reference by ID everywhere
- Use `{ toolkits: ['github'], limit: 10, important: true }` to surface only the most common tools to avoid polluting the LLM's context window

---

## 2. Tavily — Web & News Research

**Role:** Real-time web search for agents. Returns clean text snippets with citations. Replaces stale memory for current events, competitor research, and market signals.

### Package

```bash
pnpm add @tavily/core
```

Current version: `0.7.2`. CommonJS + ESM.

### Initialization

```typescript
import { tavily } from '@tavily/core';

const tvly = tavily({
  apiKey: process.env.TAVILY_API_KEY,
  sessionId: sessionId,       // optional — multi-agent tracking
  clientName: 'beevibe',
});
```

### Search

```typescript
const result = await tvly.search('competitor X product launch', {
  searchDepth: 'advanced',    // fetches actual pages; best for RAG
  topic: 'news',              // 'general' | 'news' | 'finance'
  maxResults: 5,
  includeAnswer: 'advanced',  // LLM-synthesized summary over results
  timeRange: 'week',          // 'day' | 'week' | 'month' | 'year'
  includeUsage: true,         // track credit consumption
});

// result.answer   — synthesized answer string
// result.results  — TavilySearchResult[]
//   .url          — citation URL
//   .title
//   .content      — clean text snippet
//   .score        — relevance 0–1
//   .publishedDate
```

### Extraction (fetch a known URL)

```typescript
const result = await tvly.extract(['https://example.com/article'], {
  extractDepth: 'advanced',  // fetches tables, embedded content
  format: 'markdown',
});
// result.results[0].rawContent — full page body
// result.failedResults        — URLs that failed with .error
```

Up to 20 URLs per call.

### Search Depth Trade-offs

| Depth | Cost | Latency | Use Case |
|---|---|---|---|
| `"ultra-fast"` | < 1 credit | Sub-second | Real-time voice loops |
| `"fast"` | < 1 credit | Sub-second | High-frequency polling |
| `"basic"` | 1 credit | Moderate | Simple keyword lookups |
| `"advanced"` | 2 credits | Slower | RAG pipelines, deep research |

`"advanced"` fetches and parses the actual pages server-side — eliminates a separate scraping step.

### MCP Server (no install needed)

```bash
claude mcp add --transport http tavily \
  "https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_API_KEY}"
```

MCP tools exposed: `tavily-search`, `tavily-extract`, `tavily-crawl`, `tavily-map`.

### Pricing

| Tier | Cost | Credits/month |
|---|---|---|
| Free | $0 | 1,000 |
| Pay-as-you-go | $0.008/credit | On demand |
| Researcher | $30/mo | ~4,000+ |
| Startup | $100/mo | ~15,000+ |

Rate limits: 100 req/min (dev), 1,000 req/min (production).

### Key Environment Variables

| Variable | Purpose |
|---|---|
| `TAVILY_API_KEY` | Required |

### Integration Notes for Beevibe

- Research Agent calls `tvly.search()` with `searchDepth: 'advanced'` and passes `result.results` as cited context to the LLM
- Use `topic: 'news'` for current event queries, `topic: 'finance'` for market/revenue questions
- `includeAnswer: 'advanced'` gives a pre-synthesized answer — useful when the agent needs a quick summary, not full RAG
- `timeRange: 'week'` avoids returning stale results for competitive intelligence
- Track `result.usage.credits` in telemetry to monitor spend

---

## 3. Nebius (Token Factory) — Cloud Inference

**Role:** OpenAI-compatible cloud LLM inference with 60+ open-source models. Used when we need non-Claude models, high-throughput parallelism, or cost-optimized background tasks.

> **Note:** Nebius AI Studio has been rebranded to **Nebius Token Factory** (November 2025). Use the new base URL below for all new integrations.

### Package

No new package needed — use the existing `openai` npm package with `baseURL` override.

```typescript
import OpenAI from 'openai';

const nebius = new OpenAI({
  baseURL: 'https://api.tokenfactory.nebius.com/v1/',
  apiKey: process.env.NEBIUS_API_KEY,
});
```

### Available Models (selection)

| Model ID | Notes |
|---|---|
| `meta-llama/Llama-3.3-70B-Instruct` | Strong general-purpose, 128K ctx |
| `meta-llama/Meta-Llama-3.1-8B-Instruct` | Fast, cheap background tasks |
| `deepseek-ai/DeepSeek-V3-0324` | Best non-reasoning, 1M token context |
| `deepseek-ai/DeepSeek-R1-0528` | Reasoning model |
| `Qwen/Qwen3-235B-A22B` | Large MoE |
| `Qwen/Qwen2.5-72B-Instruct` | Solid mid-tier |
| `BAAI/bge-en-icl` | Embeddings, 1536 dims |
| `Qwen/Qwen3-Embedding-8B` | Embeddings, ranking-capable |

Model IDs use `org/model-name` format (Hugging Face style). Always store as config, not hardcoded.

### Chat Completions

```typescript
const response = await nebius.chat.completions.create({
  model: 'meta-llama/Llama-3.3-70B-Instruct',
  messages: [{ role: 'user', content: '...' }],
  tools: [...],               // function calling — same OpenAI schema
  tool_choice: 'auto',
  response_format: {          // structured output
    type: 'json_schema',
    json_schema: { name: 'result', schema: { ... } },
  },
  stream: false,
});
```

### Streaming

```typescript
const stream = await nebius.chat.completions.create({
  model: 'deepseek-ai/DeepSeek-R1-0528',
  messages: [{ role: 'user', content: '...' }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
```

### Embeddings

```typescript
const result = await nebius.embeddings.create({
  model: 'BAAI/bge-en-icl',
  input: 'text to embed',
  encoding_format: 'float',
});
// result.data[0].embedding → number[] (1536 dims)
```

### Authentication

- API keys scoped per project (mandatory as of Jan 2026)
- Created at: `https://tokenfactory.nebius.com/project/api-keys`
- Use one key per environment (dev/prod)

### Rate Limits & Pricing

| Tier | Limit |
|---|---|
| Shared (default) | ~400K TPM account-wide |
| Llama 3.3-70B | 3M TPM, 3K RPM |
| DeepSeek-V3 | 1M TPM, 3K RPM |
| Dedicated endpoints | No enforced throttle, 99.9% SLA |

Approximate pricing (shared tier):

| Model size | Input | Output |
|---|---|---|
| Small (≤8B) | ~$0.02–0.06/M tokens | ~$0.02–0.06/M |
| Mid (30B) | ~$0.10/M | ~$0.30/M |
| Large (70B) | ~$0.25/M | ~$0.75/M |
| Frontier (DeepSeek V3/R1) | ~$1.93/M | ~$1.93/M |

Batch API: additional 20–30% discount for async workloads.

### Key Environment Variables

| Variable | Purpose |
|---|---|
| `NEBIUS_API_KEY` | Required |

### Integration Notes for Beevibe

- Wrap in a `NebiusLlmProvider` implementing the existing `LlmProvider` port — just set `baseURL` in the OpenAI constructor
- Use `meta-llama/Meta-Llama-3.1-8B-Instruct` for cheap background classification/routing tasks
- Use `Llama-3.3-70B-Instruct` for general agent tasks needing strong reasoning at lower cost than Claude
- `DeepSeek-V3-0324` for tasks needing very long context (1M tokens)
- Nebius can serve as the cloud compute backend for the OpenCode runtime via `--provider openrouter` with Nebius models listed on OpenRouter

---

## 4. Hermes (NousResearch) — Browser Agent Runtime

**Role:** Agent CLI with browser automation (Browser Use integration), web research, and terminal tools. Used for the live-audio teacher demo and any tasks requiring real browser interaction.

### Installation

```bash
# Install from NousResearch releases or their docs
# Binary lands on PATH as `hermes`
hermes setup  # interactive setup wizard
```

Config root: `~/.hermes/`

### One-Shot Invocation (Beevibe daemon pattern)

```typescript
import { execa } from 'execa';

const result = await execa('hermes', [
  '-z', taskPrompt,         // -z: stdout = final response only, no decoration
  '--quiet',                // suppress banner/spinner/tool previews
  '--provider', 'openrouter',
  '--model', 'anthropic/claude-3-5-sonnet',
  '--toolsets', 'browser,web,terminal',
  '--source', 'beevibe',
  '--max-turns', '20',
  '--yolo',                 // skip approval prompts (required for unattended)
  '--profile', agentId,     // isolated config per agent
], {
  env: {
    ...process.env,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    BROWSER_USE_API_KEY: process.env.BROWSER_USE_API_KEY,
  },
  cwd: workspacePath,
});
const output = result.stdout;
```

### Key CLI Flags

| Flag | Short | Purpose |
|---|---|---|
| `-z "prompt"` | | One-shot: stdout = clean response text |
| `--query "..."` | `-q` | One-shot via `chat` subcommand |
| `--quiet` | `-Q` | Suppress banner/spinner for programmatic use |
| `--provider <id>` | | Force provider: `openrouter`, `anthropic`, `nous`, `openai`, etc. |
| `--model <model>` | `-m` | Override model |
| `--toolsets <csv>` | `-t` | Enabled toolsets: `browser`, `web`, `terminal`, `skills` |
| `--source <tag>` | | Session source tag (use `beevibe`) |
| `--max-turns <N>` | | Max tool-call iterations (default: 90) |
| `--yolo` | | Skip all approval prompts |
| `--profile <name>` | `-p` | Isolated config namespace per agent |
| `--ignore-rules` | | Skip AGENTS.md/SOUL.md/memory injection |

### Provider Support

200–300+ models via:
- **Nous Portal** — first-party, 300+ models (`hermes setup --portal`)
- **OpenRouter** — `OPENROUTER_API_KEY`
- **Anthropic** — `ANTHROPIC_API_KEY`
- **OpenAI** — `OPENAI_API_KEY`
- **DeepSeek, xAI/Grok, Hugging Face, NovitaAI, NVIDIA NIM**, and more

Provider keys go in `~/.hermes/.env`. For multi-tenant/per-agent isolation, inject via subprocess `env` option instead.

### Browser Automation

Hermes supports multiple browser backends (priority order):
1. **Browserbase** — cloud, highest priority if credentials present
2. **Browser Use** — REST API cloud browser; `BROWSER_USE_API_KEY`
3. **Local CDP** — attach to Chrome/Brave/Edge via DevTools Protocol
4. **Camofox** — local anti-detection Firefox
5. **Local agent-browser** — Chromium via `agent-browser` CLI

Configure Browser Use:
```bash
# ~/.hermes/.env
BROWSER_USE_API_KEY=<key>

# or
hermes setup tools  # → Browser Automation → Browser Use
```

Available browser tools the agent can use: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_scroll`, `browser_press`, `browser_back`, `browser_get_images`, `browser_vision`, `browser_console`, `browser_cdp`.

### MCP Integration

**Hermes as MCP server** (lets Beevibe call Hermes tools via MCP protocol):
```bash
hermes mcp serve  # exposes ~10 tools over stdio
```

Add to Beevibe's MCP config:
```json
{
  "mcpServers": {
    "hermes": {
      "command": "hermes",
      "args": ["mcp", "serve"]
    }
  }
}
```

**Hermes consuming MCP servers** (lets Hermes use Composio/Tavily MCP tools):
```yaml
# ~/.hermes/config.yaml
mcp_servers:
  composio:
    url: "https://mcp.composio.dev/..."
  tavily:
    url: "https://mcp.tavily.com/mcp/?tavilyApiKey=..."
```

### Profile Isolation (important for Beevibe)

Each Beevibe agent should use its own Hermes profile to avoid session/config collision:
```bash
hermes profile create <agent_id>
hermes --profile <agent_id> -z "task prompt" ...
```

This isolates model config, session history, and browser state per agent.

### Configuration

```bash
hermes config set <key> <value>   # set a config value
hermes config show                # dump config
hermes config env-path            # path to ~/.hermes/.env
```

### Key Environment Variables

| Variable | Purpose |
|---|---|
| `BEEVIBE_HERMES_PROVIDER` | Override provider for daemon-launched Hermes sessions |
| `BROWSER_USE_API_KEY` | Browser Use cloud backend |
| `OPENROUTER_API_KEY` | OpenRouter backend |
| `ANTHROPIC_API_KEY` | Anthropic backend |

### Integration Notes for Beevibe

- The existing `HermesRuntime` adapter in `packages/core/src/adapters/hermes/runtime.ts` already handles subprocess invocation — extend it with `--profile agentId` for isolation
- Use `hermes mcp serve` as a long-lived sidecar process for the live-audio teacher loop where multiple turns need structured tool calls
- Browser Use cloud handles the case where Hermes needs to inspect a user's current page during live audio; local CDP handles when the agent should share the user's browser identity
- Pass `BROWSER_USE_API_KEY` and provider keys via subprocess `env` — do not rely on `~/.hermes/.env` in production where credentials vary per user

---

## Summary

| Provider | npm package | Env var | Role |
|---|---|---|---|
| Composio | `@composio/core` + `@composio/anthropic` | `COMPOSIO_API_KEY` | Work tool actions (Gmail, Slack, GitHub, etc.) |
| Tavily | `@tavily/core` | `TAVILY_API_KEY` | Real-time web search + citations |
| Nebius | `openai` (baseURL override) | `NEBIUS_API_KEY` | Cloud LLM inference (open-source models) |
| Hermes | CLI binary `hermes` | `BEEVIBE_HERMES_PROVIDER`, `BROWSER_USE_API_KEY` | Browser agent runtime |

All four providers are already referenced in `.env.example` (`COMPOSIO_API_KEY`, `TAVILY_API_KEY`, `NEBIUS_API_KEY`) or in the existing Hermes runtime adapter.
