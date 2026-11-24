import { describe, expect, it } from "vitest";
import { readAllCss } from "@/styles/cssSource";
import { readFileSync } from "node:fs";

/**
 * Gates for the agent panel's collapsible work section and its approval dock.
 *
 * Root cause (2026-11-08): the turn's work section, its thinking block and its
 * tool cards are nested native <details>. React dispatches a descendant's
 * toggle event to ancestor onToggle handlers, so the work section's handler
 * read the CHILD's open state and wrote it to itself: collapsing one tool
 * collapsed the whole section, and reopening revealed every previously opened
 * child at once. A descendant CSS selector (`.agent-turn-work[open]
 * .agent-tool-chevron`) also spun every tool chevron when the section opened,
 * reading as "all tools expanded". The approval / question cards were a
 * centered modal overlay instead of sitting above the input box.
 *
 * A node test without DOM cannot click details, so the invariants are locked
 * at the source: one writer per open state, the chevron rotation scoped to its
 * own summary, and the cards in normal flow above the composer (ZCode's bottom
 * dock). The live click-through is verified in the browser harness.
 */
const css = readAllCss().replace(/\/\*[\s\S]*?\*\//g, "");
const transcript = readFileSync("src/components/agent/Transcript.tsx", "utf8");
const panel = readFileSync("src/components/agent/AgentPanel.tsx", "utf8");

const rule = (selector: string): string => {
  for (const block of css.split("}")) {
    const at = block.lastIndexOf("{");
    if (at < 0) continue;
    const selectors = block
      .slice(0, at)
      .split(",")
      .map((s: string) => s.trim());
    if (selectors.includes(selector)) return block.slice(at + 1);
  }
  expect(null, `${selector} 规则消失`).not.toBeNull();
  return "";
};

describe("turn work section: one writer per open state", () => {
  /** The work section's own toggle handler, from its opening to the next `}}`. */
  const toggleHandler = (): string => {
    const start = transcript.indexOf("onToggle={(e) => {");
    return transcript.slice(start, transcript.indexOf("}}", start) + 2);
  };

  it("the section's own toggle is the only writer of its open state, through the rule module", () => {
    // React walks the fiber tree for onToggle, so a child details' toggle also
    // reaches this handler; `own` separates the two. What each kind does
    // (descendant vs own, echo of our own write vs the user's click) is the
    // rule module `./turnWork.ts`, unit-tested in turnWork.test.ts.
    const handler = toggleHandler();
    expect(handler).toMatch(/own: e\.target === e\.currentTarget/);
    expect(handler).toMatch(/applySectionToggle\(/);
    expect(handler.match(/setSection/g)).toHaveLength(1);
  });

  it("the streaming → done edge decides through openWhenSettled", () => {
    // The collapse, the user's own choice and a turn with nothing but work to
    // read are one rule; writing the boolean inline here is how the rules drift
    // apart (the echo bug of 2026-11-23 lived in this handler).
    expect(transcript).toMatch(/openWhenSettled\(current, turn, answer\)/);
  });
});

describe("chevron rotation is scoped to its own summary", () => {
  it("the work section rotates only its own chevron, not every tool chevron", () => {
    expect(rule(".agent-turn-work[open] > summary .agent-tool-chevron")).toMatch(
      /transform:\s*rotate\(90deg\)/,
    );
    // The unscoped descendant selector is the bug: it matched every tool
    // chevron inside an open section.
    expect(css).not.toMatch(/\.agent-turn-work\[open\]\s+\.agent-tool-chevron/);
  });

  it("a tool chevron rotates only when that tool is open", () => {
    expect(rule(".agent-tool[open] .agent-tool-chevron")).toMatch(/transform:\s*rotate\(90deg\)/);
  });
});

describe("approval / question cards sit above the composer (ZCode's bottom dock)", () => {
  it("the card wrapper is a normal-flow dock item, not a centered modal overlay", () => {
    const wrapper = rule(".agent-approval");
    expect(wrapper).not.toMatch(/position:\s*absolute/);
    expect(wrapper).not.toMatch(/inset:/);
    expect(wrapper).toMatch(/flex-shrink:\s*0/);
  });

  it("the card spans the column and scrolls inside a bounded height", () => {
    const card = rule(".agent-approval-card");
    expect(card).not.toMatch(/max-width:\s*420px/);
    expect(card).toMatch(/max-height:\s*min\(60vh,\s*420px\)/);
    expect(card).toMatch(/overflow:\s*auto/);
  });

  it("both cards render before the composer, exactly once (not as a trailing overlay)", () => {
    const code = panel.replace(/\/\*[\s\S]*?\*\//g, "");
    const composerAt = code.indexOf('className="agent-composer"');
    const approvalAt = code.indexOf("<AgentApprovalCard");
    const questionAt = code.indexOf("<AgentQuestionCard");
    expect(composerAt).toBeGreaterThan(-1);
    expect(approvalAt).toBeGreaterThan(-1);
    expect(questionAt).toBeGreaterThan(-1);
    expect(approvalAt).toBeLessThan(composerAt);
    expect(questionAt).toBeLessThan(composerAt);
    // Exactly one mount each: a second copy after the composer would reintroduce
    // the overlay.
    expect(code.split("<AgentApprovalCard").length).toBe(2);
    expect(code.split("<AgentQuestionCard").length).toBe(2);
  });
});

describe("a send while the previous turn is still generating", () => {
  it("tells the user instead of returning silently", () => {
    // Root cause (2026-11-12): after a stop, the next message was accepted by
    // the backend, whose model request then failed and retried invisibly. The
    // panel stayed on "generating", and `send()` returned without a word when
    // the user pressed Enter again — the only feedback-free path in the panel.
    const send = panel.slice(panel.indexOf("async function send()"));
    const guardAt = send.indexOf("if (busyRef.current === info)");
    expect(guardAt).toBeGreaterThan(-1);
    const guard = send.slice(guardAt, send.indexOf("return;", guardAt));
    expect(guard).toMatch(/showToast\(/);
  });
});

/**
 * Gate for the prompt box as a vim surface.
 *
 * The composer used to be a `<textarea>`, which cannot run the notes area's vim
 * engine: a second vim implemented over a textarea would drift from the
 * engine's rules and could not share the vimrc's mappings (the parser, the
 * native `imap` registrations and the command mappings all belong to
 * `@replit/codemirror-vim`). It is now a CodeMirror editor mounting the same
 * extensions, configured from the one vimrc copy the loader publishes.
 */
describe("the agent composer runs the shared vim engine", () => {
  const composer = readFileSync("src/components/agent/AgentComposer.tsx", "utf8");
  const panelSrc = readFileSync("src/components/agent/AgentPanel.tsx", "utf8");

  it("the vim mount is the notes area's extension set, driven by the global switch", () => {
    expect(composer).toMatch(/useAppStore\(\(s\) => s\.settings\.vim\)/);
    for (const ext of ["vimModeExtension()", "vimKeyCaptureExtension()", "vimActiveLine()"]) {
      expect(composer).toContain(ext);
    }
    expect(composer).toContain("commandMappingKeymap(mappings)");
    // One vimrc for both: the composer renders from the loader's copy and is
    // notified when it reloads (a note switch or an edited vimrc).
    expect(composer).toContain("onVimMappingsChanged(setMappings)");
    expect(composer).toContain("vimMappings");
  });

  it("the panel mounts the editor, not a textarea, and routes its own keys before the engine", () => {
    expect(panelSrc).not.toContain("<textarea");
    expect(panelSrc.split("<AgentComposer").length).toBe(2);
    // The routed keys are one rule module; the component keeps the capture
    // listener (Preview) so the engine inside never sees them.
    expect(panelSrc).toContain("composerKeyAction({");
    expect(composer).toContain("onKeyDownCapture={onKeyDownCapture}");
  });

  it("the IME intent of the box follows the global vim switch", () => {
    // vim on → the mode decides (insert Chinese, normal English); vim off →
    // the plain Chinese writing field it always was.
    expect(composer).toContain("imeOnComposerFocus(true)");
    // The Chinese-field marker is dropped while vim is on: the mode decides
    // then, and the marker would pin the field to Chinese.
    expect(composer).toContain('...(vim ? {} : { "data-ime-chinese": "true" }),');
    expect(panelSrc).toContain("imeOnComposerFocus(true)");
  });
});

/**
 * Gate for "edit and resend" (ZCode's `editUserQuery`).
 *
 * The panel used to offer no way back: a wrong prompt could only be followed by
 * a correction, and the model kept reading the wrong question plus whatever the
 * first attempt had produced. The rewrite is a branch cut, so the three parts
 * that must agree are locked here at the source: the send path takes the edit
 * route, the dying turn is silenced while the backend rewinds, and the record
 * gets the marker that makes a restore read the same conversation.
 */
describe("edit and resend", () => {
  const panelSrc = readFileSync("src/components/agent/AgentPanel.tsx", "utf8");
  const transcriptSrc = readFileSync("src/components/agent/Transcript.tsx", "utf8");
  const streamSrc = readFileSync("src/components/agent/streamEvents.ts", "utf8");

  it("sending an edit calls the backend rewrite, never a plain send", () => {
    const edited = panelSrc.slice(panelSrc.indexOf("async function sendEdited("));
    expect(edited).toContain("agentApi.editUserMessage(");
    // The trimmed rows and the record marker both come from the backend's
    // kept count and the surviving prefix (one source for both).
    expect(edited).toContain("rewindPrefix(live?.entries ?? conv.entries, edit.index)");
    expect(edited).toContain("writer.persistRewind(conv.key, rewindKeep(prefix))");
  });

  it("a running turn is discarded while the rewrite happens", () => {
    // The stream handler must not draw or record the turn being cut away, or
    // the partial reply comes back above the rewritten message.
    expect(panelSrc).toContain("discardingRef.current.add(conv.key)");
    expect(panelSrc).toContain("discarding: (convKey) => discardingRef.current.has(convKey)");
    expect(streamSrc).toContain("if (discarded(convKey)) return;");
    expect(streamSrc).toContain("if (discarded(convKey)) return;\n    ctx.persistTurn");
  });

  it("only the last user message offers the handle, and it says where the text went", () => {
    expect(transcriptSrc).toContain("editable={editTarget === index}");
    expect(transcriptSrc).toContain("editing={editingIndex === index}");
    expect(transcriptSrc).toContain("这条消息正在下方输入框里编辑");
    expect(transcriptSrc).toContain("✎ 编辑中");
    expect(panelSrc).toContain(
      "editTargetIndex =\n    activeConv && !activeConv.agent && activeConv.sessionId\n      ? lastUserEntryIndex(activeConv.entries)",
    );
  });

  it("the composer says it is rewriting a message and can always send", () => {
    expect(panelSrc).toContain('className="agent-edit-bar"');
    expect(panelSrc).toContain("正在编辑上一条消息");
    // While a turn runs the button is Stop; an edit is what stops it, so the
    // button must stay Send in edit mode.
    expect(panelSrc).toContain(
      "busy={activeBusy && !(editing && editing.convKey === activeConv?.key)}",
    );
  });
});
