import { useState } from "react";

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/** `ask_user_question` is waiting for an answer. */
export interface PendingQuestion {
  sessionId: string;
  id: string;
  questions: AskQuestion[];
}

/**
 * `ask_user_question` arrives as unknown JSON: narrow it before rendering.
 */
export function parseQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question : "";
    if (!question) continue;
    const options: { label: string; description?: string }[] = [];
    if (Array.isArray(record.options)) {
      for (const option of record.options) {
        if (!option || typeof option !== "object") continue;
        const entry = option as Record<string, unknown>;
        if (typeof entry.label !== "string") continue;
        options.push({
          label: entry.label,
          description: typeof entry.description === "string" ? entry.description : undefined,
        });
      }
    }
    out.push({
      question,
      header: typeof record.header === "string" ? record.header : undefined,
      multiSelect: record.multiSelect === true,
      options,
    });
  }
  return out;
}

/**
 * The card above the composer for `ask_user_question`. The picks are local
 * state (the caller mounts it with `key={pending.id}`), and the answer is
 * formatted as "question → a, b" blocks, one per question.
 */
export function AgentQuestionCard({
  pending,
  onSubmit,
}: {
  pending: PendingQuestion;
  onSubmit: (answer: string) => void;
}) {
  const [answers, setAnswers] = useState<Record<number, string[]>>({});

  const toggle = (index: number, label: string) => {
    const q = pending.questions[index];
    setAnswers((prev) => {
      const current = prev[index] ?? [];
      const next = q?.multiSelect
        ? current.includes(label)
          ? current.filter((v) => v !== label)
          : [...current, label]
        : [label];
      return { ...prev, [index]: next };
    });
  };

  const answer = pending.questions
    .map((q, index) => {
      const picked = answers[index] ?? [];
      return picked.length > 0 ? `${q.question}\n→ ${picked.join(", ")}` : null;
    })
    .filter((line): line is string => line !== null)
    .join("\n\n");

  return (
    <div className="agent-approval" role="dialog" aria-label="模型提问">
      <div className="agent-approval-card">
        {pending.questions.map((q, index) => {
          const picked = answers[index] ?? [];
          return (
            <div key={index} className="agent-question">
              <div className="agent-approval-head">
                <span className="agent-approval-title">{q.header || `问题 ${index + 1}`}</span>
              </div>
              <p className="agent-question-text">{q.question}</p>
              <div className="agent-question-options">
                {q.options.map((option) => (
                  <button
                    key={option.label}
                    className={`agent-question-option${
                      picked.includes(option.label) ? " is-picked" : ""
                    }`}
                    title={option.description}
                    onClick={() => toggle(index, option.label)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        <div className="agent-approval-actions">
          <button
            className="agent-approval-allow"
            disabled={pending.questions.some((_, index) => (answers[index] ?? []).length === 0)}
            onClick={() => onSubmit(answer)}
          >
            提交
          </button>
        </div>
      </div>
    </div>
  );
}
