"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Bot } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { Skeleton } from "@/components/skeleton";
import { useAgents } from "@/lib/hooks/use-agents";
import type { AgentDisplay } from "@/lib/types/agents";

/**
 * Knowledge-graph view of a team: pill-shaped nodes for the team agent
 * and its specialists, connected by solid edges with a small role
 * label. Used on /agents (full size) and on the dashboard's Home page
 * (compact).
 *
 * Three size variants — same visual language, just smaller pills:
 *   - "large"     — full graph (used on /agents).
 *   - "compact"   — embeds (e.g. dashboard summary).
 *   - "satellite" — peer graphs around the caller's own on the
 *                   network canvas. Edge labels are dropped here.
 */
export type TeamOrbitSize = "large" | "compact" | "satellite";

interface OrbitMetrics {
  size: number;
  radius: number;
  teamWidth: number;
  teamHeight: number;
  icWidth: number;
  icHeight: number;
  teamAvatar: number;
  icAvatar: number;
}

const METRICS: Record<TeamOrbitSize, OrbitMetrics> = {
  large: {
    size: 780,
    radius: 290,
    teamWidth: 260,
    teamHeight: 132,
    icWidth: 230,
    icHeight: 118,
    teamAvatar: 30,
    icAvatar: 24,
  },
  compact: {
    size: 580,
    radius: 210,
    teamWidth: 210,
    teamHeight: 114,
    icWidth: 190,
    icHeight: 104,
    teamAvatar: 26,
    icAvatar: 22,
  },
  satellite: {
    size: 400,
    radius: 165,
    teamWidth: 160,
    teamHeight: 88,
    icWidth: 144,
    icHeight: 78,
    teamAvatar: 20,
    icAvatar: 18,
  },
};

interface Position {
  x: number;
  y: number;
}

function orbitPositions(count: number, radius: number): Position[] {
  if (count === 0) return [];
  if (count === 1) return [{ x: 0, y: -radius }];
  const raw = Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * 2 * Math.PI - Math.PI / 2;
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  });
  // For odd counts (3, 5, 7...) the natural radial layout is
  // vertically lopsided — one node directly above center but multiple
  // nodes only partway below. Shift the whole ring so its vertical
  // bounding box is centered, putting the team agent at the visual
  // centroid. Even counts are already balanced and yShift evaluates
  // to 0.
  const ys = raw.map((p) => p.y);
  const yShift = -(Math.min(...ys) + Math.max(...ys)) / 2;
  return raw.map((p) => ({ x: p.x, y: p.y + yShift }));
}

/**
 * Click handler for an agent node. When supplied, nodes intercept the
 * default navigation to /agents/:id so callers can open the agent in a
 * peek panel instead of a full route change. The Link href stays
 * intact so right-click "open in new tab" still works.
 */
export type AgentSelectHandler = (agentId: string) => void;

/**
 * Render a single team's knowledge graph. Pass an explicit `agents`
 * array (typed as one team + its IC subordinates); the component picks
 * the top-level agent as the center and arranges the ICs around it.
 * For a self-rendering convenience that fetches the caller's own
 * agents, use <SelfTeamOrbit /> below.
 */
export function TeamOrbit({
  agents,
  size = "large",
  loading = false,
  onSelect,
}: {
  agents: AgentDisplay[] | undefined;
  size?: TeamOrbitSize;
  loading?: boolean;
  onSelect?: AgentSelectHandler;
}) {
  if (loading) return <OrbitSkeleton size={size} />;
  if (!agents || agents.length === 0) return <OrbitEmpty />;

  // Primary = the highest-tier non-IC agent. With strict hierarchy
  // ordering (org > team > ic), the network endpoint sorts org-tier
  // agents first, so teams[0] is the org-tier captain when present
  // (the counter-launch CEO), otherwise the first team-tier agent.
  const teams = agents.filter((a) => a.hierarchy !== "ic");
  const primary = teams[0];
  if (!primary) return <OrbitEmpty />;

  // Render the whole subtree under primary in the orbit — depth-1
  // (team → ICs) AND depth-2 (org → team leads → ICs). Without this,
  // an org-tier captain shows an empty orbit because none of its ICs
  // are DIRECT children (they're grandchildren via the team leads).
  const subtree = collectDescendants(primary.id, agents);
  // "Other teams" = peer team agents whose root sits elsewhere in the
  // network (different person's team, or a sibling team not under the
  // current primary). Don't double-render anyone already in the orbit.
  const subtreeIds = new Set(subtree.map((a) => a.id));
  const otherTeams = teams.filter(
    (t) => t.id !== primary.id && !subtreeIds.has(t.id),
  );

  return (
    <div>
      <Graph
        team={primary}
        ics={subtree}
        size={size}
        onSelect={onSelect}
      />
      {otherTeams.length > 0 ? (
        <section className="mt-12">
          <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
            Other teams
          </h2>
          <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {otherTeams.map((team) => (
              <li key={team.id}>
                <CyberCard agent={team} size="compact" role="team" onSelect={onSelect} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * BFS over parent_agent_id to collect every descendant of `rootId`
 * (excluding the root itself). Ordering: layer-by-layer — depth-1
 * children first, then depth-2, etc. Within a layer, the input order is
 * preserved (the network endpoint already sorts by hierarchy then name).
 *
 * This is what lets the orbit visualize multi-tier hierarchies (org →
 * team → ic) instead of only depth-1 (team → ic).
 */
function collectDescendants(
  rootId: string,
  agents: AgentDisplay[],
): AgentDisplay[] {
  const out: AgentDisplay[] = [];
  const frontier = [rootId];
  const seen = new Set<string>([rootId]);
  while (frontier.length > 0) {
    const parent = frontier.shift()!;
    for (const a of agents) {
      if (a.parent_agent_id !== parent) continue;
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
      frontier.push(a.id);
    }
  }
  return out;
}

/**
 * Self-rendering convenience — fetches the caller's own agents and
 * passes them to TeamOrbit. Used on the dashboard's compact summary.
 */
export function SelfTeamOrbit({ size = "large" }: { size?: TeamOrbitSize }) {
  const { data, isLoading } = useAgents();
  return <TeamOrbit agents={data} size={size} loading={isLoading} />;
}

function Graph({
  team,
  ics,
  size,
  onSelect,
}: {
  team: AgentDisplay;
  ics: AgentDisplay[];
  size: TeamOrbitSize;
  onSelect?: AgentSelectHandler;
}) {
  const m = METRICS[size];
  const cardWidth = Math.max(m.teamWidth, m.icWidth);
  const cardHeight = Math.max(m.teamHeight, m.icHeight);
  const showLabels = size === "large";

  // Index every node's children once; used by both the subtree-width
  // computation and the recursive layout pass.
  const childrenOf = new Map<string, AgentDisplay[]>();
  for (const a of ics) {
    const pid = a.parent_agent_id ?? team.id;
    const list = childrenOf.get(pid) ?? [];
    list.push(a);
    childrenOf.set(pid, list);
  }

  // Spacing between sibling subtrees and between vertical levels.
  // Tuned to keep depth-2 (org → team → ic) readable at "large" size.
  const hGap = 60;
  const vGap = 80;

  // Bottom-up: each subtree consumes either its own card width or the
  // sum of its children's widths (with gaps), whichever is larger.
  const subtreeWidth = (id: string): number => {
    const children = childrenOf.get(id) ?? [];
    if (children.length === 0) return cardWidth;
    const total =
      children.reduce((s, c) => s + subtreeWidth(c.id), 0) +
      (children.length - 1) * hGap;
    return Math.max(cardWidth, total);
  };

  // Top-down: walk the tree, assign each node its (centerX, centerY).
  // Children are centred horizontally under their parent and span
  // proportionally to their own subtree widths so dense branches don't
  // collide with sparse ones.
  const positions = new Map<string, { x: number; y: number }>();
  const layout = (nodeId: string, centerX: number, y: number): void => {
    positions.set(nodeId, { x: centerX, y });
    const children = childrenOf.get(nodeId) ?? [];
    if (children.length === 0) return;
    const totalChildWidth =
      children.reduce((s, c) => s + subtreeWidth(c.id), 0) +
      (children.length - 1) * hGap;
    let cursorX = centerX - totalChildWidth / 2;
    for (const child of children) {
      const w = subtreeWidth(child.id);
      layout(child.id, cursorX + w / 2, y + cardHeight + vGap);
      cursorX += w + hGap;
    }
  };

  const canvasWidth = Math.max(cardWidth, subtreeWidth(team.id)) + 40;
  const rootCenterX = canvasWidth / 2;
  const rootY = cardHeight / 2 + 20;
  layout(team.id, rootCenterX, rootY);

  // Canvas height = deepest node's y + margin.
  let maxY = rootY;
  for (const pos of positions.values()) {
    if (pos.y > maxY) maxY = pos.y;
  }
  const canvasHeight = maxY + cardHeight / 2 + 20;

  // Elbow paths from each non-root node up to its parent. The half-way
  // horizontal segment is the classic org-chart shape; reads as "these
  // siblings share a parent" without needing extra labels.
  const edges = ics
    .map((a) => {
      const childPos = positions.get(a.id);
      const parentId = a.parent_agent_id ?? team.id;
      const parentPos = positions.get(parentId);
      if (!childPos || !parentPos) return null;
      const parentBottom = parentPos.y + cardHeight / 2;
      const childTop = childPos.y - cardHeight / 2;
      const midY = (parentBottom + childTop) / 2;
      const d = `M ${parentPos.x} ${parentBottom} V ${midY} H ${childPos.x} V ${childTop}`;
      return { id: a.id, d, midX: childPos.x, midY };
    })
    .filter(<T,>(v: T | null): v is T => v !== null);

  return (
    <div
      className="relative mx-auto"
      style={{ width: canvasWidth, height: canvasHeight }}
    >
      <svg
        className="absolute inset-0 pointer-events-none"
        viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
        aria-hidden
      >
        {edges.map((e) => (
          <path
            key={e.id}
            d={e.d}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-muted-foreground/40"
          />
        ))}
      </svg>

      {showLabels
        ? edges.map((e) => (
            <span
              key={e.id}
              className="absolute z-[1] text-[9px] uppercase tracking-wider font-medium text-muted-foreground/80 bg-background px-1.5 py-0.5 rounded-full pointer-events-none select-none"
              style={{
                left: `${(e.midX / canvasWidth) * 100}%`,
                top: `${(e.midY / canvasHeight) * 100}%`,
                transform: "translate(-50%, -50%)",
              }}
            >
              reports to
            </span>
          ))
        : null}

      {(() => {
        const teamPos = positions.get(team.id);
        if (!teamPos) return null;
        return (
          <div
            className="absolute z-[2]"
            style={{
              left: teamPos.x,
              top: teamPos.y,
              transform: "translate(-50%, -50%)",
            }}
          >
            <CyberCard agent={team} size={size} role="team" onSelect={onSelect} />
          </div>
        );
      })()}

      {ics.map((member) => {
        const pos = positions.get(member.id);
        if (!pos) return null;
        // Team-tier descendants render in the "team" card style;
        // IC-tier in the "ic" style. So engineering-lead reads as a
        // team agent, eng-ic reads as an IC, all in one tree.
        const role = member.hierarchy === "ic" ? "ic" : "team";
        return (
          <div
            key={member.id}
            className="absolute z-[2]"
            style={{
              left: pos.x,
              top: pos.y,
              transform: "translate(-50%, -50%)",
            }}
          >
            <CyberCard agent={member} size={size} role={role} onSelect={onSelect} />
          </div>
        );
      })}
    </div>
  );
}

// ── Cyber card node ──────────────────────────────────────────────────

// data-pan="ignore" tells the canvas pan handler to skip drag-starts
// that begin on a card. Without it the click still fires but the
// pointer-down also starts a canvas pan, which feels laggy.
function cardInteractionProps(
  agentId: string,
  onSelect: AgentSelectHandler | undefined,
) {
  if (!onSelect) return { "data-pan": "ignore" as const };
  return {
    "data-pan": "ignore" as const,
    onClick: (e: React.MouseEvent) => {
      // Let cmd/ctrl/middle/shift-clicks fall through so they keep the
      // open-in-new-tab behavior the Link provides.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      onSelect(agentId);
    },
  };
}

function CyberCard({
  agent,
  size,
  role,
  onSelect,
}: {
  agent: AgentDisplay;
  size: TeamOrbitSize;
  role: "team" | "ic";
  onSelect?: AgentSelectHandler;
}) {
  const m = METRICS[size];
  const isTeam = role === "team";
  const width = isTeam ? m.teamWidth : m.icWidth;
  const height = isTeam ? m.teamHeight : m.icHeight;
  const avatarSize = isTeam ? m.teamAvatar : m.icAvatar;
  const initial = (agent.display_name ?? agent.name ?? "?").charAt(0).toUpperCase();
  const showFooter = size !== "satellite";

  const titleSize =
    size === "large"
      ? isTeam ? "text-lg" : "text-base"
      : size === "compact"
        ? "text-sm"
        : "text-xs";

  const cardRef = useRef<HTMLAnchorElement | null>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });

  const onMove = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    setTilt({
      x: (ny - 0.5) * 18,
      y: (nx - 0.5) * -18,
    });
  };
  const onLeave = () => setTilt({ x: 0, y: 0 });

  return (
    <Link
      ref={cardRef}
      href={`/agents/${agent.id}`}
      {...cardInteractionProps(agent.id, onSelect)}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className="cyber-card block cursor-pointer"
      style={{
        width,
        height,
        transform: `perspective(800px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
      }}
    >
      <div className="cyber-glare" />
      <div className="cyber-lines">
        <span />
        <span />
      </div>
      <div className="cyber-corners">
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="cyber-scan" />
      <div className="relative h-full z-[1]" style={{ padding: 12 }}>
        <div className="flex items-center gap-2">
          <Avatar
            initial={initial}
            kind={agent.hierarchy}
            label={agent.display_name ?? agent.name}
            specialization={agent.specialization}
            size={avatarSize}
          />
          <span className="cyber-badge text-[9px] uppercase tracking-[0.18em] font-mono">
            {isTeam ? "TEAM" : "AGENT"}
          </span>
        </div>
        {/* Title sits in its own overflow box so `truncate`'s horizontal
            clipping doesn't pinch the vertical line-box and lop the
            bottom off bold gradient glyphs. */}
        <div
          className="mt-2 overflow-hidden"
          style={{ paddingBottom: 2 }}
        >
          <div
            className={`cyber-title font-semibold whitespace-nowrap text-ellipsis overflow-hidden ${titleSize}`}
            style={{ lineHeight: 1.5 }}
          >
            {agent.display_name ?? agent.name}
          </div>
        </div>
        {showFooter ? (
          <div
            className="cyber-footer absolute flex items-center justify-between text-[10px] uppercase tracking-wider font-mono"
            style={{ left: 12, right: 12, bottom: 12 }}
          >
            <span className="truncate min-w-0">
              {agent.specialization ?? agent.hierarchy}
            </span>
            <span className="cyber-footer-accent tabular-nums shrink-0 ml-2">
              {agent.sessions_count ?? 0}s · {agent.facts_learned ?? 0}f
            </span>
          </div>
        ) : null}
      </div>
    </Link>
  );
}

// ── Empty / loading ──────────────────────────────────────────────────

function OrbitEmpty() {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-6 text-sm text-muted-foreground">
      <Bot className="h-6 w-6 mb-2 text-muted-foreground/60" />
      <p className="font-medium text-foreground">No agents yet</p>
      <p className="mt-1 max-w-sm text-center leading-relaxed">
        Your team agent will spawn specialists when you point it at a codebase.
      </p>
    </div>
  );
}

function OrbitSkeleton({ size }: { size: TeamOrbitSize }) {
  const m = METRICS[size];
  return (
    <div
      className="mx-auto flex flex-col items-center gap-5"
      style={{ width: m.size }}
    >
      <div style={{ width: m.teamWidth, height: m.teamHeight }}>
        <Skeleton className="h-full w-full rounded-2xl" />
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ width: m.icWidth, height: m.icHeight }}>
            <Skeleton className="h-full w-full rounded-2xl" />
          </div>
        ))}
      </div>
    </div>
  );
}
