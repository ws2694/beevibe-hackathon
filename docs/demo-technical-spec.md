# Demo Technical Specification — Provider Mapping

Maps each step of the hackathon demo script to concrete provider calls and data flows.

---

## Demo Flow Overview

```
Step 0: Voice + vision     -> speech capture + current screen/browser context
Step 1: Morning brief      -> Composio (read) + Tavily (web signals)
Step 2: Delegation         -> Beevibe internal routing
Step 3: Agent teamwork     -> Tavily (research) + Composio (read tools) + Nebius (parallel inference) + Hermes (browser)
Step 4: Human decision     -> Composio (Slack notify) + Nebius (synthesis)
Step 5: Real action        -> Composio (write tools)
Step 6: Org evolution      -> Beevibe creates or updates agent roles, rituals, and playbooks
```

---

## Step 0 — Voice + Vision Control Plane

**User story:** CEO can be anywhere, looking at anything, and speak a command
that Beevibe grounds in the current work context.

Example:

> "Beevibe, what am I looking at, who should handle this, and what changed overnight?"

The voice layer is an input router, not a separate executor. It converts speech
and screen context into the same Beevibe primitives the chat UI already uses:
chat turns, tasks, approvals, agent updates, and org evolution events.

### MVP voice mode — browser speech + browser TTS

Reuse the lightweight approach from the interview-prep project:

- `SpeechRecognition` captures interim and final transcript text.
- `MediaRecorder` can capture an optional audio blob for debugging or future
  audio-capable models.
- A small silence detector ends the turn after the user pauses.
- Browser `speechSynthesis` speaks the short Beevibe reply.
- Raw audio is optional; transcript-first keeps the flow compatible with small
  hosted or local models.

```typescript
type VoiceTurn = {
  transcript: string;
  source: 'web' | 'mobile' | 'slack' | 'meeting';
  started_at: string;
  ended_at: string;
  delivery?: {
    duration_sec: number;
    word_count: number;
    long_pauses: number;
  };
};
```

For the first hackathon build, the client can send the transcript to existing
`POST /chat` with a compact prefix:

```text
[voice source=web]
User said: "Prepare a response team for this competitor launch."

Current context:
- URL: https://competitor.example/launch
- Title: Competitor launches AI workflow suite
- Selected text: "New enterprise pricing tier..."
- Visible summary: launch page, feature list, pricing claims
```

### Realtime voice mode — upgrade path

For a more natural demo, use a realtime speech model over WebRTC. The realtime
model should still emit structured text events back into the Beevibe router so
the company OS remains deterministic:

```typescript
type VoiceIntent =
  | { kind: 'brief_me'; scope: 'overnight' | 'today' | 'mission' }
  | { kind: 'delegate_mission'; mission: string }
  | { kind: 'approve_action'; target_id?: string; note?: string }
  | { kind: 'ask_agent_status'; agent_name?: string; mission_id?: string }
  | { kind: 'create_agent'; name: string; reason: string }
  | { kind: 'pause_voice' };
```

### Vision context

Vision means "ground the spoken command in what the user is seeing." Start with
text context because it is safer and easier to demo; screenshots can be opt-in.

```typescript
type ContextEvent = {
  kind: 'screen' | 'browser' | 'doc' | 'meeting' | 'tool';
  source: 'web_app' | 'browser_extension' | 'composio' | 'hermes';
  title?: string;
  url?: string;
  selected_text?: string;
  visible_text_summary?: string;
  screenshot_ref?: string;
  evidence?: Array<{ label: string; url?: string; text?: string }>;
};
```

Recommended MVP sources:

| Source | How to capture | Demo use |
|---|---|---|
| Beevibe web app | active route, selected entity, current task/session | "What is blocked here?" |
| Browser extension | URL, title, selected text, visible text | "What am I looking at?" |
| Composio | Slack/Gmail/Calendar/CRM state | "What needs me?" |
| Hermes | deeper browser inspection when text is insufficient | "Inspect this page and compare it to our roadmap." |

---

## Step 1 — Morning Brief: "What happened overnight?"

**User story:** CEO asks from anywhere. Beevibe summarizes urgent messages, open decisions, agent progress, web signals, and calendar prep.

The personal agent runs a parallel fan-out: one Composio call per work tool, one Tavily call for market signals, all in parallel.

### Composio — Read work context

All of these run concurrently. `userId` = the CEO's Beevibe user ID.

```typescript
const [emails, slackMentions, calendarToday, openDecisions] = await Promise.all([

  // Unread emails from last 8 hours
  composio.tools.execute('GMAIL_FETCH_EMAILS', {
    userId,
    arguments: {
      query: 'is:unread newer_than:8h',
      max_results: 20,
      include_spam_trash: false,
    },
  }),

  // Slack DMs and @mentions since yesterday
  composio.tools.execute('SLACK_LIST_MESSAGES', {
    userId,
    arguments: {
      channel: 'im',         // DMs
      oldest: yesterdayTs,   // Unix timestamp
      limit: 30,
    },
  }),

  // Today's calendar events
  composio.tools.execute('GOOGLECALENDAR_LIST_EVENTS', {
    userId,
    arguments: {
      time_min: todayStart,  // ISO 8601
      time_max: todayEnd,
      order_by: 'startTime',
    },
  }),

  // Open decisions in Linear/Notion flagged for CEO review
  composio.tools.execute('LINEAR_LIST_ISSUES', {
    userId,
    arguments: {
      filter: { state: { name: { eq: 'Needs Decision' } }, assignee: { me: true } },
      first: 10,
    },
  }),
]);
```

**Toolkits to connect:** `gmail`, `slack`, `googlecalendar`, `linear`

### Tavily — Overnight market/web signals

```typescript
const webSignals = await tvly.search(
  `${companyDomain} competitor industry news`,
  {
    searchDepth: 'basic',   // 1 credit — fast enough for a morning brief
    topic: 'news',
    timeRange: 'day',       // last 24 hours only
    maxResults: 5,
    includeAnswer: 'basic', // quick synthesized summary
    includeUsage: true,
  }
);
// webSignals.answer     → one-line summary for the brief
// webSignals.results[]  → cited articles with .url, .title, .publishedDate
```

### Nebius — Personal agent LLM inference (optional path)

If the personal agent session is assigned to the Nebius runtime (e.g., to save Claude quota on a lightweight summarization):

```typescript
const nebius = new OpenAI({
  baseURL: 'https://api.tokenfactory.nebius.com/v1/',
  apiKey: process.env.NEBIUS_API_KEY,
});

const brief = await nebius.chat.completions.create({
  model: 'meta-llama/Llama-3.3-70B-Instruct',
  messages: [
    { role: 'system', content: personalAgentSystemPrompt },
    { role: 'user', content: buildBriefPrompt({ emails, slackMentions, calendarToday, openDecisions, webSignals }) },
  ],
  max_tokens: 600,
});
```

Model choice rationale: Llama-3.3-70B at ~$0.25/M tokens for a read-only synthesis task. Reserve Claude for interactive turns.

---

## Step 2 — Delegation: "Prepare a response to the competitor launch."

**User story:** Beevibe creates a mission and routes it to specialist agents.

This step is Beevibe-internal (task creation + routing). No provider calls at creation time, but the personal agent may log the mission to a tracked tool:

```typescript
// Optional: record the mission in Linear for audit trail
await composio.tools.execute('LINEAR_CREATE_ISSUE', {
  userId,
  arguments: {
    title: 'Competitor response — [CompetitorName] launch',
    description: missionSummary,
    teamId: execTeamId,
    stateId: inProgressStateId,
    priority: 1,  // urgent
  },
});
```

Beevibe then spawns five specialist agent sessions (each a separate daemon claim):

| Agent | Runtime | Model |
|---|---|---|
| Research Agent | Hermes or Claude Code | `deepseek-ai/DeepSeek-V3-0324` (Nebius) or Claude |
| Product Agent | Claude Code | Claude Sonnet |
| Sales Agent | Claude Code | Claude Sonnet |
| Finance Agent | Nebius direct | `Qwen/Qwen2.5-72B-Instruct` |
| Comms Agent | Claude Code | Claude Sonnet |

---

## Step 3 — Agent Teamwork

**User story:** Agents research, ask each other questions, disagree, and converge on options.

### Research Agent — Tavily (primary tool)

```typescript
// Round 1: find competitor's launch details
const launchDetails = await tvly.search(
  `"${competitorName}" product launch announcement`,
  {
    searchDepth: 'advanced', // 2 credits — fetches actual pages, not just snippets
    topic: 'news',
    timeRange: 'week',
    maxResults: 8,
    includeAnswer: 'advanced',
    includeRawContent: 'markdown', // full page body for RAG context
    includeUsage: true,
  }
);

// Round 2: pull customer/analyst reaction
const marketReaction = await tvly.search(
  `${competitorName} launch customer reaction analyst opinion`,
  {
    searchDepth: 'advanced',
    topic: 'general',
    timeRange: 'week',
    maxResults: 5,
    includeAnswer: 'basic',
  }
);

// Round 3: extract full content from a specific press release or blog post
const pressRelease = await tvly.extract(
  [launchDetails.results[0].url],
  {
    extractDepth: 'advanced', // tables, embedded content
    format: 'markdown',
  }
);
```

**Credit budget for Research Agent:** ~7–9 credits per run (3× advanced search + 1× advanced extract).

### Research Agent — Hermes (browser fallback)

When a competitor page is behind a login wall, requires JavaScript rendering, or Tavily can't extract it:

```typescript
import { execa } from 'execa';

const result = await execa('hermes', [
  '-z',
  `Visit ${competitorUrl} and extract: product features, pricing, target customers, launch date. Return structured bullet points.`,
  '--quiet',
  '--provider', 'openrouter',
  '--toolsets', 'browser,web',
  '--source', 'beevibe',
  '--max-turns', '10',
  '--yolo',
  '--profile', researchAgentId,
], {
  env: {
    ...process.env,
    BROWSER_USE_API_KEY: process.env.BROWSER_USE_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  },
  timeout: 120_000,
});
const browserFindings = result.stdout;
```

### Product Agent — Composio (roadmap read)

```typescript
// Read product roadmap from Notion
const roadmap = await composio.tools.execute('NOTION_QUERY_DATABASE', {
  userId: productAgentUserId,
  arguments: {
    database_id: process.env.NOTION_ROADMAP_DB_ID,
    filter: {
      property: 'Status',
      select: { equals: 'In Progress' },
    },
    sorts: [{ property: 'Priority', direction: 'descending' }],
    page_size: 20,
  },
});

// Check open Linear epics for overlap with competitor features
const epics = await composio.tools.execute('LINEAR_LIST_ISSUES', {
  userId: productAgentUserId,
  arguments: {
    filter: { type: { eq: 'Epic' }, state: { name: { in: ['In Progress', 'Planned'] } } },
    first: 15,
  },
});
```

**Agent question to mesh:** "Does our roadmap already address [feature X]?" — the product agent posts its finding back to a shared Beevibe task note so other agents can read it.

### Sales Agent — Composio (pipeline read)

```typescript
// Identify deals at risk from competitor
const atRiskDeals = await composio.tools.execute('HUBSPOT_LIST_DEALS', {
  userId: salesAgentUserId,
  arguments: {
    properties: ['dealname', 'amount', 'closedate', 'dealstage', 'hs_deal_stage_probability'],
    filters: [
      { propertyName: 'dealstage', operator: 'NOT_IN', values: ['closedwon', 'closedlost'] },
      { propertyName: 'closedate', operator: 'LT', value: ninetyDaysOut },
    ],
    limit: 25,
    sort: [{ propertyName: 'amount', direction: 'DESCENDING' }],
  },
});

// Pull contacts at accounts where competitor is known to be evaluating
const contacts = await composio.tools.execute('HUBSPOT_LIST_CONTACTS', {
  userId: salesAgentUserId,
  arguments: {
    properties: ['firstname', 'lastname', 'email', 'company', 'hs_lead_status'],
    filterGroups: [{ filters: [{ propertyName: 'company', operator: 'CONTAINS_TOKEN', value: knownCompetitorAccounts }] }],
    limit: 20,
  },
});
```

**Sales agent position (for mesh negotiation):** "Option A (aggressive pricing) protects 4 deals totaling $X. Recommend A."

### Finance Agent — Nebius (structured output)

Finance agent uses Nebius directly with JSON schema output to extract revenue exposure numbers:

```typescript
const exposure = await nebius.chat.completions.create({
  model: 'Qwen/Qwen2.5-72B-Instruct',
  messages: [
    { role: 'system', content: financeAgentPrompt },
    { role: 'user', content: `Given these deals: ${JSON.stringify(atRiskDeals)} and competitor launch context: ${launchSummary}, estimate revenue exposure by quarter.` },
  ],
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'revenue_exposure',
      schema: {
        type: 'object',
        properties: {
          at_risk_arr: { type: 'number' },
          by_quarter: {
            type: 'array',
            items: { type: 'object', properties: { quarter: { type: 'string' }, amount: { type: 'number' } }, required: ['quarter', 'amount'] },
          },
          recommended_option: { type: 'string', enum: ['A', 'B'] },
          rationale: { type: 'string' },
        },
        required: ['at_risk_arr', 'by_quarter', 'recommended_option', 'rationale'],
      },
    },
  },
});
const financePosition = JSON.parse(exposure.choices[0].message.content!);
```

### Parallel inference budget (Nebius)

All five specialist agents can run simultaneously. With Nebius shared tier (~400K TPM):

| Agent | Model | Est. tokens/run | Cost |
|---|---|---|---|
| Research Agent | DeepSeek-V3 | ~8K in, ~2K out | ~$0.02 |
| Product Agent | Claude Sonnet | (own billing) | — |
| Sales Agent | Claude Sonnet | (own billing) | — |
| Finance Agent | Qwen2.5-72B | ~5K in, ~1K out | ~$0.001 |
| Comms Agent | Claude Sonnet | (own billing) | — |

Nebius handles Finance + Research routing; Claude handles Product, Sales, Comms.

---

## Step 4 — Human Decision

**User story:** Beevibe escalates: "Sales prefers A, Product prefers B. I recommend B. Approve?"

The personal agent synthesizes all specialist positions and sends a decision request to the CEO.

### Composio — Push decision to CEO

```typescript
// DM the CEO on Slack with decision inbox link
await composio.tools.execute('SLACK_SENDS_A_MESSAGE', {
  userId,
  arguments: {
    channel: ceosSlackUserId,      // DM
    text: [
      `*Competitor response — decision needed*`,
      `• Sales recommends Option A (aggressive pricing) — protects $${salesPosition.atRiskArr.toLocaleString()} ARR`,
      `• Product recommends Option B (feature acceleration) — aligns with roadmap`,
      `• Finance: Option A saves more short-term, Option B better for enterprise positioning long-term`,
      ``,
      `*My recommendation: Option B* — preserves enterprise pricing integrity.`,
      ``,
      `<${decisionInboxUrl}|Review and approve →>`,
    ].join('\n'),
  },
});
```

### Decision inbox (Beevibe-internal)

The web UI shows the full tradeoff table with agent reasoning and cited sources. CEO approves inline (or by voice through the audio interface).

---

## Step 5 — Real Action

**User story:** CEO approves. Beevibe updates the team, drafts the customer message, and records the decision.

All four Composio writes run after approval is confirmed.

```typescript
await Promise.all([

  // 1. Notify the team in Slack
  composio.tools.execute('SLACK_SENDS_A_MESSAGE', {
    userId,
    arguments: {
      channel: companyChannelId,
      text: `*Decision made:* Option B — accelerating feature roadmap in response to ${competitorName} launch. @product @engineering please see updated Linear priorities.`,
    },
  }),

  // 2. Draft customer-facing message in Gmail (draft, not send — human reviews)
  composio.tools.execute('GMAIL_CREATE_DRAFT', {
    userId,
    arguments: {
      to: [accountExecEmail],
      subject: `Our response to recent market developments`,
      body: commsDraft,           // written by Comms Agent
      cc: [],
    },
  }),

  // 3. Record decision in Notion
  composio.tools.execute('NOTION_UPDATE_PAGE', {
    userId,
    arguments: {
      page_id: missionPageId,
      properties: {
        Status: { select: { name: 'Decision Recorded' } },
        Decision: { rich_text: [{ text: { content: 'Option B approved by CEO' } }] },
        'Decided At': { date: { start: new Date().toISOString() } },
      },
    },
  }),

  // 4. Update Linear mission to In Progress
  composio.tools.execute('LINEAR_UPDATE_ISSUE', {
    userId,
    arguments: {
      id: missionIssueId,
      stateId: inProgressStateId,
      description: `Decision: Option B. Owner: Product. Target: ${sprintDeadline}.`,
    },
  }),
]);
```

---

## Step 6 — Org Evolution: "Make that permanent."

**User story:** the company OS notices repeated work and proposes a durable org
change. The CEO can approve it by voice.

Example:

> "Make competitive intelligence permanent."

Beevibe creates a new agent role instead of treating this as a one-off task.

```typescript
type OrgEvolutionEvent = {
  action:
    | 'create_agent'
    | 'specialize_agent'
    | 'promote_agent'
    | 'add_ritual'
    | 'update_playbook'
    | 'reorg_agent';
  reason: string;
  requested_by: 'human' | 'agent';
  source_session_id: string;
  proposed_change: Record<string, unknown>;
  requires_approval: boolean;
};
```

### Create Competitive Intelligence Agent

```typescript
const evolution: OrgEvolutionEvent = {
  action: 'create_agent',
  reason: 'Competitor launches require repeated cross-functional response work.',
  requested_by: 'human',
  source_session_id: missionSessionId,
  requires_approval: true,
  proposed_change: {
    name: 'Competitive Intelligence Agent',
    parent_agent: 'GTM Team Agent',
    charter:
      'Monitor competitor launches, pricing changes, customer reactions, and analyst coverage.',
    tools: ['tavily', 'slack', 'hubspot', 'notion'],
    rituals: [
      {
        cadence: 'weekly',
        prompt: 'Scan competitor and market signals every Monday morning.',
      },
    ],
    escalation_rule:
      'Escalate when competitor activity touches active pipeline above $100K ARR.',
    seeded_memory: {
      from_session_id: missionSessionId,
      include: ['launch summary', 'agent disagreement', 'approved response'],
    },
  },
};
```

### UI proof

The demo should make the org evolution visible:

- new agent appears in the org map
- parent/reporting line is drawn under GTM or CEO
- tool badges appear: Tavily, Slack, HubSpot, Notion
- ritual appears: weekly competitor scan
- memory card appears: seeded from competitor response mission
- timeline entry appears: "Company OS evolved"

This is the core hackathon differentiation: agents do not just complete work;
they teach the company how to operate next time.

---

## Provider Call Summary by Demo Step

| Step | Composio | Tavily | Nebius | Hermes |
|---|---|---|---|---|
| 0. Voice + vision | Optional Composio context reads | — | Small intent router / realtime synthesis | Browser context fallback |
| 1. Morning brief | `GMAIL_FETCH_EMAILS`, `SLACK_LIST_MESSAGES`, `GOOGLECALENDAR_LIST_EVENTS`, `LINEAR_LIST_ISSUES` | `search()` — news, 1 day, basic | Llama-3.3-70B for brief synthesis | — |
| 2. Delegation | `LINEAR_CREATE_ISSUE` | — | — | — |
| 3. Agent teamwork | `NOTION_QUERY_DATABASE`, `LINEAR_LIST_ISSUES`, `HUBSPOT_LIST_DEALS`, `HUBSPOT_LIST_CONTACTS` | `search()` × 2 advanced, `extract()` × 1 | Qwen2.5-72B for finance analysis | `hermes -z` for JS-rendered competitor pages |
| 4. Human decision | `SLACK_SENDS_A_MESSAGE` | — | Llama-3.3-70B for tradeoff synthesis | — |
| 5. Real action | `SLACK_SENDS_A_MESSAGE`, `GMAIL_CREATE_DRAFT`, `NOTION_UPDATE_PAGE`, `LINEAR_UPDATE_ISSUE` | — | — | — |
| 6. Org evolution | Optional Slack/Notion announcement | Future recurring scans | Agent-role synthesis | Optional browser research ritual |

---

## Credit / Cost Estimate Per Demo Run

| Provider | Usage | Estimated Cost |
|---|---|---|
| Composio | ~12 tool calls | Free tier / plan-based |
| Tavily | 2× advanced search (4 credits) + 1× advanced extract (2 credits) = 6 credits | ~$0.05 at PAYG |
| Nebius | ~15K tokens total (Finance + Research + brief) | ~$0.005 |
| Hermes | 1× browser session, ~10 turns | Browser Use credits |
| Claude (Anthropic) | Product, Sales, Comms agents + personal agent | Separate billing |

---

## Composio Toolkit Connection Checklist

Before the demo, connect the CEO user account to each toolkit via `composio.connectedAccounts.link()`:

- [ ] `gmail` — OAuth2, read + compose + send scopes
- [ ] `slack` — OAuth2, `channels:read`, `chat:write`, `im:write`, `im:history`
- [ ] `googlecalendar` — OAuth2, `calendar.readonly`
- [ ] `linear` — API key or OAuth2, `issues:read`, `issues:write`
- [ ] `notion` — OAuth2, page + database read/write
- [ ] `hubspot` — OAuth2, CRM contacts + deals read

Pin toolkit versions in `Composio` constructor before first production run.
