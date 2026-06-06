# Beevibe Everywhere

### An always-on company OS that coordinates humans and agent teams across work.

Beevibe Everywhere is the hackathon version of Beevibe: a team AI operating
layer that reduces the friction of using AI at work. It gives every team a
front-door team agent plus a mesh of specialist IC agents that follow the work
across chat, voice, email, calendar, browser, and team tools.

Most agent demos show one AI doing one task. Beevibe Everywhere shows an AI
organization working with your organization: humans describe outcomes in the
places they already collaborate, team agents route the work, IC agents gather
evidence and negotiate disagreements, and Beevibe brings the right decisions
back to the right people.

## Hackathon Pitch

Teams do not want every person prompting a separate AI and manually pasting
answers back into Slack. Beevibe turns team communication into coordinated AI
work.

A teammate can be anywhere and say:

> "Beevibe, what needs me today?"

Beevibe answers with the important parts:

- the investor email that needs approval
- the product decision blocked on Sales and Finance
- the competitor signal from today's web research
- the teammate waiting on your call
- the agents already working in the background

Then the team can delegate:

> "Handle the competitor response. Research the market, align Product and Sales,
> draft the customer message, and only come back to me for the decision."

Beevibe turns that into agent teamwork:

- Research Agent searches the web and pulls evidence
- Product Agent checks roadmap impact
- Sales Agent reviews customer risk
- Finance Agent estimates revenue exposure
- Comms Agent drafts the external message
- The team agent summarizes the tradeoffs and asks the right human for approval

## What Makes It Different

Beevibe Everywhere is not a chatbot bolted onto a dashboard. It is an agent
operating layer for a company.

- **Audio-first presence:** the demo is controlled by voice. The user can ask
  for a brief, delegate a mission, interrupt agents, approve actions, or create
  a new role without typing.
- **Vision-aware context:** Beevibe can ground a voice command in what the user
  is looking at: a browser tab, dashboard, document, customer account, inbox
  thread, or meeting note.
- **Everywhere interface:** talk to your agents from web, Slack, SMS, voice, or
  wherever the hackathon demo routes messages.
- **Team/org front door:** humans address Beevibe as a team or org agent. The
  team agent owns internal delegation; people should not need to command IC
  agents directly.
- **Specialist team mesh:** agents can ask peers for help, negotiate conflicts,
  create tasks, update work products, and escalate blockers.
- **Shared team context:** Beevibe keeps work from fragmenting across one-off
  prompts, private chats, and forgotten AI outputs.
- **Evolving organization:** repeated missions can create new agent roles,
  promote authority, add rituals, update playbooks, or reorganize reporting
  lines. The company OS learns how the company should operate next time.
- **Shared memory:** agents remember durable facts about the company, project,
  and people instead of relearning everything each session.
- **Decision inbox:** humans do not review every tool call. They review the
  few decisions that actually need judgment.
- **Runtime flexibility:** local or cloud runtimes can claim work, so the same
  company brain can run through different agent harnesses.

## Audio, Vision, and Org Evolution

The hackathon demo should feel less like "chat with an agent" and more like
"talk to the company."

```text
User voice
  "Beevibe, what am I looking at and who should handle this?"
        |
        v
Audio command layer
  transcript / intent / interruption / approval
        |
        v
Vision context layer
  active page / selected text / screenshot summary / tool state
        |
        v
Company OS
  team/org agent / specialist IC agents / tasks / memory / tools
        |
        v
Org evolution
  create agent / specialize role / add ritual / update playbook
```

The signature moment is voice-driven evolution:

> "Make competitive intelligence permanent."

Beevibe creates a Competitive Intelligence Agent, gives it approved tools,
assigns it under the GTM Team Agent, seeds it with memory from the mission, and
adds a weekly competitor-scan ritual.

The important product stance: Beevibe is not one person's assistant. It is the
coordination layer that lets a team use AI without losing context, ownership,
review, or trust.

## Sponsor Integration Story

The hackathon version is shaped around a company-OS demo:

- **Composio** connects Beevibe to daily work tools like Gmail, Slack, Notion,
  Linear, GitHub, HubSpot, and Calendar.
- **Tavily** gives agents current web and news research instead of stale memory.
- **Nebius** provides cloud inference and compute for always-on or heavy agent
  work.
- **OpenClaw or another harness** can be added as a runtime so Beevibe stays
  above any single agent execution engine.

Beevibe remains the coordination layer: identity, memory, hierarchy, tasks,
agent-to-agent negotiation, human escalation, audit trail, and team-visible
work state.

## Demo Script

1. **Voice and vision wake-up**

   A teammate is looking at a competitor launch page, sales dashboard, or
   urgent Slack thread and says:

   > "Beevibe, what am I looking at and what needs me?"

   Beevibe captures the spoken command, attaches screen/browser context, and
   routes it through the right team agent.

2. **Morning brief**

   A manager or teammate asks from anywhere:

   > "What happened overnight?"

   Beevibe summarizes urgent messages, open decisions, agent progress, web
   signals, and calendar prep.

3. **Delegation**

   The team says in Slack or voice:

   > "Prepare a response to the competitor launch."

   Beevibe creates a mission and routes it to specialist agents.

4. **Agent teamwork**

   The live mesh shows agents researching, asking each other questions,
   disagreeing, and converging on options.

5. **Human decision**

   Beevibe escalates:

   > "Sales prefers option A, Product prefers option B. I recommend B because
   > it preserves enterprise pricing. Approve?"

6. **Real action**

   The accountable human approves by chat or voice. Beevibe updates the team,
   drafts the customer message, and records the decision.

7. **Org evolution**

   The team lead says:

   > "Make that competitive intelligence function permanent."

   Beevibe creates the new agent role, updates the org map, and stores the
   mission as a reusable company playbook.

## Architecture

Beevibe Everywhere keeps the existing Beevibe control-plane shape:

```text
Everywhere inputs
  web chat / Slack / SMS / voice / browser
          |
          v
Team/org agent
  front door / routing / priorities / escalation / shared memory
          |
          v
Agent team mesh
  IC agents: research / product / sales / finance / engineering / ops
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

Beevibe Everywhere turns scattered AI tools into an always-on company OS:
your team talks from anywhere, and Beevibe coordinates specialist agents that
research, negotiate, decide, and act across your real work tools.
