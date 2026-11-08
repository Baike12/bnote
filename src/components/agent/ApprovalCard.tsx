import { useState } from "react";

/** A tool marked `ask` is waiting for approval. */
export interface ApprovalRequest {
  sessionId: string;
  id: string;
  tool: string;
  input: unknown;
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * The approval card stacked above the composer: the turn is parked until the
 * user answers.
 *
 * The rejection reason is local state and the caller mounts the card with
 * `key={approval.id}`, so the next request starts with an empty box.
 */
export function AgentApprovalCard({
  approval,
  onReply,
}: {
  approval: ApprovalRequest;
  onReply: (allow: boolean, feedback?: string) => void;
}) {
  const [feedback, setFeedback] = useState("");
  return (
    <div className="agent-approval" role="dialog" aria-label="工具授权">
      <div className="agent-approval-card">
        <div className="agent-approval-head">
          <span className="agent-approval-title">
            {approval.tool === "ExitPlanMode" ? "计划待批准" : "需要授权"}
          </span>
          <code className="agent-approval-tool">{approval.tool}</code>
        </div>
        <pre className="agent-approval-input">
          {approval.tool === "ExitPlanMode"
            ? String((approval.input as { plan?: string } | null)?.plan ?? "")
            : prettyJson(approval.input)}
        </pre>
        <input
          className="agent-approval-feedback"
          placeholder="拒绝原因(可选,会告诉模型)"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
        <div className="agent-approval-actions">
          <button className="agent-approval-allow" onClick={() => onReply(true)}>
            允许
          </button>
          <button
            className="agent-approval-deny"
            onClick={() => onReply(false, feedback || undefined)}
          >
            拒绝
          </button>
        </div>
      </div>
    </div>
  );
}
