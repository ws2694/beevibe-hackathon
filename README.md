# Beevibe Everywhere

### An always-on company Jarvis that coordinates agent teams across your daily work.

Beevibe Everywhere is the hackathon version of Beevibe: a personal AI chief of
staff plus a mesh of specialist agents that can follow you across chat, voice,
email, calendar, browser, and team tools.

Most agent demos show one AI doing one task. Beevibe Everywhere shows an AI
organization working with you: your personal agent understands what you need,
routes work to specialist agents, gathers evidence, negotiates disagreements,
asks humans for decisions, and takes action in the tools your team already uses.

## Hackathon Pitch

You can be anywhere and say:

> "Beevibe, what needs me today?"

Beevibe answers with the important parts:

- the investor email that needs approval
- the product decision blocked on Sales and Finance
- the competitor signal from today's web research
- the teammate waiting on your call
- the agents already working in the background

Then you can delegate:

> "Handle the competitor response. Research the market, align Product and Sales,
> draft the customer message, and only come back to me for the decision."

Beevibe turns that into agent teamwork:

- Research Agent searches the web and pulls evidence
- Product Agent checks roadmap impact
- Sales Agent reviews customer risk
- Finance Agent estimates revenue exposure
- Comms Agent drafts the external message
- Your personal agent summarizes the tradeoffs and asks for approval

## What Makes It Different

Beevibe Everywhere is not a chatbot bolted onto a dashboard. It is an agent
operating layer for a company.

- **Everywhere interface:** talk to your agents from web, Slack, SMS, voice, or
  wherever the hackathon demo routes messages.
- **Personal agent:** one agent knows your role, priorities, preferences, and
  decision style.
- **Specialist team mesh:** agents can ask peers for help, negotiate conflicts,
  create tasks, update work products, and escalate blockers.
- **Shared memory:** agents remember durable facts about the company, project,
  and people instead of relearning everything each session.
- **Decision inbox:** humans do not review every tool call. They review the
  few decisions that actually need judgment.
- **Runtime flexibility:** local or cloud runtimes can claim work, so the same
  company brain can run through different agent harnesses.

## Sponsor Integration Story

The hackathon version is shaped around a Jarvis-for-work demo:

- **Composio** connects Beevibe to daily work tools like Gmail, Slack, Notion,
  Linear, GitHub, HubSpot, and Calendar.
- **Tavily** gives agents current web and news research instead of stale memory.
- **Nebius** provides cloud inference and compute for always-on or heavy agent
  work.
- **OpenClaw or another harness** can be added as a runtime so Beevibe stays
  above any single agent execution engine.

Beevibe remains the coordination layer: identity, memory, hierarchy, tasks,
agent-to-agent negotiation, human escalation, and audit trail.

## Demo Script

1. **Morning brief**

   CEO asks from anywhere:

   > "What happened overnight?"

   Beevibe summarizes urgent messages, open decisions, agent progress, web
   signals, and calendar prep.

2. **Delegation**

   CEO says:

   > "Prepare a response to the competitor launch."

   Beevibe creates a mission and routes it to specialist agents.

3. **Agent teamwork**

   The live mesh shows agents researching, asking each other questions,
   disagreeing, and converging on options.

4. **Human decision**

   Beevibe escalates:

   > "Sales prefers option A, Product prefers option B. I recommend B because
   > it preserves enterprise pricing. Approve?"

5. **Real action**

   CEO approves by chat or voice. Beevibe updates the team, drafts the customer
   message, and records the decision.

## Architecture

Beevibe Everywhere keeps the existing Beevibe control-plane shape:

```text
Everywhere inputs
  web chat / Slack / SMS / voice / browser
          |
          v
Personal agent
  identity / preferences / priorities / memory
          |
          v
Agent team mesh
  research / product / sales / finance / engineering / ops
          |
          v
Work tools and runtimes
  Composio tools / Tavily search / Nebius compute / local or cloud harnesses
```

The API server owns REST, SSE, MCP tools, runtime dispatch, memory, task state,
and mesh coordination. Daemons or cloud workers claim pending sessions and run
the selected agent runtime.

## Local Development

Requirements:

- Node.js 20+
- pnpm 9+
- Docker for local Postgres
- At least one supported agent CLI runtime, such as Claude Code, Codex,
  OpenCode, Hermes, or the hackathon runtime you wire in

Install:

```bash
pnpm install
```

Set environment:

```bash
cp .env.example .env
```

Fill the required values:

```bash
DATABASE_URL=postgresql://beevibe:beevibe@localhost:5433/beevibe
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
BEEVIBE_MCP_SERVER_URL=http://localhost:3000/mcp
NEXT_PUBLIC_BV_API_URL=http://localhost:3000
```

Optional hackathon integrations:

```bash
COMPOSIO_API_KEY=
TAVILY_API_KEY=
NEBIUS_API_KEY=
```

Start the local stack:

```bash
pnpm dev
```

Start the daemon in a second terminal:

```bash
pnpm daemon start
```

Open the web app:

```text
http://localhost:3001
```

## Hackathon Build Priorities

1. Everywhere input surface: web chat first, then Slack/SMS/voice if time allows.
2. Tavily-powered research tool with citations.
3. Composio-powered action tool for one or two real services.
4. Agent mesh visualization that shows work happening live.
5. Decision inbox for approvals and escalations.
6. Nebius cloud runtime or inference path.
7. Optional OpenClaw runtime adapter.

## One-Line Pitch

Beevibe Everywhere turns scattered AI tools into an always-on company Jarvis:
you talk from anywhere, and your personal agent coordinates a team of specialist
agents that research, decide, and act across your real work tools.
