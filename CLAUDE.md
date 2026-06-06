# Beevibe — Claude Code Guide

## Monorepo structure

```
packages/
  core/       shared domain, ports, services, adapters — compiled to dist/
  api/        Express API + MCP server (tsx watch src/main.ts)
  daemon/     Local agent runner (tsx watch src/main.ts start)
  scheduler/  Cron + background jobs
  web/        Next.js frontend
scripts/
  dev.sh      One-command local stack (postgres + core watch + api + scheduler)
```

## Running locally

```bash
pnpm dev          # everything: postgres, core watcher, api, scheduler, tunnel
pnpm dev --no-tunnel
```

`pnpm dev` now:
1. Kills any stale beevibe processes from previous runs
2. Starts `tsc --watch` for `@beevibe/core` so source changes compile automatically
3. Starts API and scheduler (tsx watch, reload on file change)

The **daemon** is NOT started by `pnpm dev` — start it separately:
```bash
cd packages/daemon && npx tsx watch src/main.ts start
```

## Critical: @beevibe/core compiles to dist/

`packages/core/package.json` exports point to `./dist/`, not `./src/`. Changes
to `packages/core/src/**` are **invisible** to the API and daemon until compiled.

`pnpm dev` now runs `tsc --watch` for core automatically. If you're not using
`pnpm dev` (e.g. running the API standalone), rebuild manually first:

```bash
pnpm --filter @beevibe/core build
```

After a core rebuild, touch a file in the consuming package to force tsx reload:
```bash
touch packages/api/src/runtime/router.ts   # reload API
touch packages/daemon/src/spawner.ts       # reload daemon
```

## Restarting cleanly

`pnpm dev` uses `trap 'kill 0' EXIT` but only kills its own children. If you
close the terminal without Ctrl+C, tsx/node processes linger and hold ports.

To fully reset:
```bash
pkill -f "beevibe/(packages|scripts)"
pkill -f "daemon/src/main"
```

Or just run `pnpm dev` — it does this cleanup at the start now.

## Agent runtime (Claude Code CLI)

- The CLI binary is `claude` on PATH
- Sessions spawn with `--dangerously-skip-permissions --strict-mcp-config`
- MCP config lives in `~/.beevibe/workspaces/<agent_id>/mcp-config.json`
- Agent cwd is the workspace path (`~/.beevibe/workspaces/<agent_id>`)

## Team agent routing

Team agents (hierarchy_level = 'team') in chat sessions:
- Keep full tool access — they need to read code, search repos, and write
  scratch files to ground handoffs in real context
- Must route work to subordinate specialists or recommend spawning one
- Routing directive fires post-onboarding, even with zero subordinates

Routing is enforced by prompt (`teamAgentRoutingDirective` +
`BEEVIBE_LIFECYCLE_REMINDER_CHAT`), not by tool restriction.

## Checking if a change is live

```bash
# API PID — if unchanged after touching a file, tsx didn't reload
lsof -i :3000 -sTCP:LISTEN | grep LISTEN

# Daemon log
tail -f /tmp/beevibe-daemon.log

# Verify core dist has your change
grep "your_symbol" packages/core/dist/adapters/claude-code/runtime.js
```

## Database

```bash
# Local postgres via docker-compose
docker exec beevibe-postgres psql -U beevibe -d beevibe -c "SELECT ..."

# Connection string
DATABASE_URL=postgresql://beevibe:beevibe@localhost:5433/beevibe
```

## Deploying

```bash
vercel --prod   # from beevibe-marketing for the marketing site
```

API deploys separately — see Vercel project settings.

## No mocks, no seeds, no fake data

Default to real code against real systems. The training-data pull toward
`const mockUsers = [...]`, `mockFetch()`, dummy endpoints, hardcoded seed
arrays, and stub functions is strong — resist it.

Rules:
- **No placeholders.** Do not invent mock data, seed arrays, fake responses,
  or stub functions to make code "run." If a real value, schema, or contract
  is missing, stop and ask for it.
- **Use the real exports.** Wire against the actual modules in this repo
  (e.g. `@beevibe/core` ports/adapters, the real `pool.query`, the real
  Postgres connection at `DATABASE_URL`). Do not create local arrays or
  shadow data sources.
- **Crash on mock directive.** If you find yourself about to write
  placeholder data, a mock function, or a fake API response — halt and ask
  for the real schema, endpoint, or file path instead. Do not guess.
- **Schema before code.** For non-trivial features, lay out the file
  structure and database schema first, get alignment, then implement against
  that schema. No variables initialized with hardcoded data.
- **Tests use real systems.** Integration tests hit real Postgres (see
  `feedback_testing` memory). Don't mock the database to make a test pass.

Exceptions (when mocks are fine):
- Unit tests at a true boundary where the real dependency is out of scope
  (e.g. mocking an external HTTP API in a unit test of pure parsing logic).
- Explicit user request for a prototype or scaffold.

When in doubt, ask before stubbing.
