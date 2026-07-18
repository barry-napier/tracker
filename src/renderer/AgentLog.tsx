import { useEffect, useState } from "react";
import type { AgentBlock } from "../server/provider.ts";
import { apiBase } from "./api.ts";

interface LogBlockView {
  blockId: string;
  phase: string;
  kind: AgentBlock["kind"];
  /** The block's streamed body: text, tool input, or tool output. */
  body: string;
  tool?: string;
  isError?: boolean;
  open: boolean;
}

function fromOpen(event: { blockId: string; phase: string; block: AgentBlock }): LogBlockView {
  const { block } = event;
  const base = { blockId: event.blockId, phase: event.phase, kind: block.kind, open: true };
  switch (block.kind) {
    case "tool_call":
      return { ...base, body: block.input, tool: block.tool };
    case "tool_result":
      return { ...base, body: block.output, tool: block.tool, isError: block.isError };
    default:
      return { ...base, body: block.text };
  }
}

/**
 * The run's conversation over the per-run SSE stream: full replay on open,
 * deltas appended live onto their open block.
 */
function useRunLog(runId: number): LogBlockView[] {
  const [blocks, setBlocks] = useState<LogBlockView[]>([]);

  useEffect(() => {
    setBlocks([]);
    const source = new EventSource(`${apiBase}/api/runs/${runId}/log`);

    source.addEventListener("block.open", (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data);
      setBlocks((state) => [
        ...state.filter((block) => block.blockId !== event.blockId),
        fromOpen(event),
      ]);
    });
    source.addEventListener("block.delta", (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data);
      setBlocks((state) =>
        state.map((block) =>
          block.blockId === event.blockId
            ? { ...block, body: block.body + event.textDelta }
            : block,
        ),
      );
    });
    source.addEventListener("block.close", (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data);
      setBlocks((state) =>
        state.map((block) =>
          block.blockId === event.blockId ? { ...block, open: false } : block,
        ),
      );
    });

    return () => source.close();
  }, [runId]);

  return blocks;
}

const KIND_LABELS: Record<AgentBlock["kind"], string> = {
  prompt: "prompt",
  thinking: "thinking",
  text: "agent",
  tool_call: "tool →",
  tool_result: "→ result",
};

export function AgentLog({ runId }: { runId: number }) {
  const blocks = useRunLog(runId);

  if (blocks.length === 0) return <p className="dim">No conversation yet.</p>;
  return (
    <ol className="agentlog">
      {blocks.map((block) => (
        <li key={block.blockId} className={`logblock logblock-${block.kind}`}>
          <span className="logkind dim">
            {KIND_LABELS[block.kind]}
            {block.tool && ` ${block.tool}`}
          </span>
          <pre className={block.isError ? "logbody error" : "logbody"}>
            {block.body}
            {block.open && <span className="cursor">▋</span>}
          </pre>
        </li>
      ))}
    </ol>
  );
}
