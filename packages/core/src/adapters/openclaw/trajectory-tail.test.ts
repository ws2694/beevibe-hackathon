import { describe, expect, it, vi } from "vitest";
import type { RuntimeStep } from "../../ports/runtime.js";
import { emitEvent } from "./trajectory-tail.js";

function collect(
  events: Record<string, unknown>[],
): { steps: RuntimeStep[]; finalIdx: number } {
  const steps: RuntimeStep[] = [];
  const onStep = (s: RuntimeStep): void => {
    steps.push(s);
  };
  let idx = 0;
  for (const evt of events) {
    idx = emitEvent(evt, idx, onStep);
  }
  return { steps, finalIdx: idx };
}

describe("emitEvent", () => {
  it("session.started emits one 'agent' step naming the model", () => {
    const onStep = vi.fn();
    emitEvent(
      {
        type: "session.started",
        modelId: "Qwen/Qwen3.5-397B-A17B-fast",
        ts: "2026-06-13T02:00:00.000Z",
      },
      0,
      onStep,
    );
    expect(onStep).toHaveBeenCalledTimes(1);
    const step = onStep.mock.calls[0]![0] as RuntimeStep;
    expect(step.kind).toBe("agent");
    expect(step.description).toContain("Qwen/Qwen3.5-397B-A17B-fast");
    expect(step.timestamp).toBe("2026-06-13T02:00:00.000Z");
  });

  it("session.ended emits a 'summary' step", () => {
    const onStep = vi.fn();
    emitEvent({ type: "session.ended", ts: "2026-06-13T02:05:00.000Z" }, 0, onStep);
    expect(onStep).toHaveBeenCalledTimes(1);
    expect(onStep.mock.calls[0]![0].kind).toBe("summary");
  });

  it("unknown event types emit nothing", () => {
    const onStep = vi.fn();
    emitEvent({ type: "trace.metadata" }, 0, onStep);
    emitEvent({ type: "context.compiled" }, 0, onStep);
    emitEvent({ type: "trace.artifacts" }, 0, onStep);
    expect(onStep).not.toHaveBeenCalled();
  });

  it("model.completed emits agent text + tool_call + tool_result for new messages", () => {
    const evt = {
      type: "model.completed",
      ts: "2026-06-13T02:01:00.000Z",
      data: {
        messagesSnapshot: [
          { role: "user", content: [{ type: "text", text: "do the thing" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Sure, calling the tool." },
              { type: "toolCall", id: "tc1", name: "GMAIL_SEND_EMAIL", arguments: { to: "x@y.com" } },
            ],
          },
          {
            role: "toolResult",
            content: [{ type: "text", text: '{"sent":true}' }],
          },
        ],
      },
    };
    const { steps, finalIdx } = collect([evt]);

    // user message → nothing (not assistant); assistant text → 1 step;
    // tool call → 1 step; toolResult role → 1 step.
    expect(steps.length).toBe(3);
    expect(steps[0]).toMatchObject({
      kind: "agent",
      description: "Sure, calling the tool.",
    });
    expect(steps[1]).toMatchObject({
      kind: "tool_call",
      tool: "GMAIL_SEND_EMAIL",
    });
    expect(steps[1]!.description).toContain("x@y.com");
    expect(steps[2]).toMatchObject({
      kind: "tool_result",
      description: '{"sent":true}',
    });

    // All three messages consumed.
    expect(finalIdx).toBe(3);
  });

  it("second model.completed emits ONLY incrementally-new messages (cumulative snapshot dedupe)", () => {
    const turn1 = {
      type: "model.completed",
      ts: "t1",
      data: {
        messagesSnapshot: [
          { role: "user", content: [{ type: "text", text: "first turn" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "ack turn 1" }],
          },
        ],
      },
    };
    const turn2 = {
      type: "model.completed",
      ts: "t2",
      data: {
        messagesSnapshot: [
          { role: "user", content: [{ type: "text", text: "first turn" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "ack turn 1" }],
          },
          { role: "user", content: [{ type: "text", text: "second turn" }] },
          {
            role: "assistant",
            content: [{ type: "text", text: "ack turn 2" }],
          },
        ],
      },
    };
    const { steps, finalIdx } = collect([turn1, turn2]);
    // turn1: 1 step (assistant text); turn2: 1 step (new assistant text).
    const agentSteps = steps.filter((s) => s.kind === "agent");
    expect(agentSteps.map((s) => s.description)).toEqual([
      "ack turn 1",
      "ack turn 2",
    ]);
    expect(finalIdx).toBe(4);
  });

  it("ignores empty assistant text blocks (no whitespace-only spam)", () => {
    const evt = {
      type: "model.completed",
      data: {
        messagesSnapshot: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "   " },
              { type: "text", text: "" },
              { type: "text", text: "real content" },
            ],
          },
        ],
      },
    };
    const { steps } = collect([evt]);
    expect(steps.map((s) => s.description)).toEqual(["real content"]);
  });

  it("handles missing fields defensively (no throws)", () => {
    const onStep = vi.fn();
    emitEvent({}, 0, onStep);
    emitEvent({ type: "model.completed" }, 0, onStep);
    emitEvent({ type: "model.completed", data: null }, 0, onStep);
    emitEvent(
      { type: "model.completed", data: { messagesSnapshot: null } },
      0,
      onStep,
    );
    expect(onStep).not.toHaveBeenCalled();
  });

  it("supports both tool_use and toolCall block-type names", () => {
    const evt = {
      type: "model.completed",
      data: {
        messagesSnapshot: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "1", name: "TAVILY_SEARCH", input: { query: "x" } },
              { type: "toolCall", id: "2", name: "GMAIL_SEND_EMAIL", arguments: { to: "y" } },
            ],
          },
        ],
      },
    };
    const { steps } = collect([evt]);
    expect(steps.length).toBe(2);
    expect(steps[0]).toMatchObject({ kind: "tool_call", tool: "TAVILY_SEARCH" });
    expect(steps[1]).toMatchObject({ kind: "tool_call", tool: "GMAIL_SEND_EMAIL" });
  });

  it("truncates very long tool_call argument JSON to keep events readable", () => {
    const longBody = "x".repeat(500);
    const evt = {
      type: "model.completed",
      data: {
        messagesSnapshot: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                name: "GOOGLEDRIVE_CREATE_FILE_FROM_TEXT",
                arguments: { body: longBody },
              },
            ],
          },
        ],
      },
    };
    const { steps } = collect([evt]);
    expect(steps[0]!.description.length).toBeLessThanOrEqual(201);
    expect(steps[0]!.description.endsWith("…")).toBe(true);
  });
});
