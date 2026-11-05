import { useEffect, useState } from "react";
import { useAppStore } from "@/state/appStore";
import type { AgentMode } from "@/lib/tauri";
import { Modal } from "./Modal";
import { navGroups, type Tab } from "./settings/nav";
import { GeneralTab, EditorTab, ReadingTab } from "./settings/GeneralTabs";
import { FocusTab } from "./settings/FocusTab";
import { HotkeysTab, VimTab, SnippetsTab, ImeTab, QuickAddTab } from "./settings/InputTabs";
import { DailyTab, TemplatesTab } from "./settings/NoteTabs";
import { TranslateTab } from "./settings/StudyTabs";
import {
  AgentAdvancedTab,
  AgentInstructionsTab,
  AgentMcpTab,
  AgentModelTab,
  AgentSkillsTab,
} from "./settings/AgentTabs";

/**
 * The settings window: a grouped navigation on the left, the section of the
 * selected tab on the right. Each section owns its card layout and state;
 * this file only maps a tab id to its component.
 *
 * The Agent group follows the mode the app is in: the coding agent has MCP,
 * skills, AGENTS.md and the raw settings.json; the creative agent has the same
 * without the advanced page; the study agent only has the model and
 * AGENTS.md. The pages are the modes' real configuration files, not a subset
 * of one shared form.
 */
export function SettingsModal() {
  const open = useAppStore((s) => s.modal === "settings");
  const setModal = useAppStore((s) => s.setModal);
  const mode = useAppStore((s) => s.mode);
  const creativeMode = useAppStore((s) => s.creativeMode);
  const codeProject = useAppStore((s) => s.codeProject);
  const [tab, setTab] = useState<Tab>("general");

  // Notes mode has no agent of its own; it shows the study shape, which is the
  // shape shared by the plain Q&A assistant.
  const agentMode: AgentMode =
    mode === "code" ? "coding" : mode === "study" && creativeMode ? "creative" : "study";
  const workdir = agentMode === "coding" ? (codeProject?.path ?? null) : null;

  // The modal keeps its state after closing, so a tab chosen in one mode would
  // survive into a mode that does not have it. Fall back to the first page.
  useEffect(() => {
    const missing =
      (tab === "agent-advanced" && agentMode !== "coding") ||
      ((tab === "agent-mcp" || tab === "agent-skills") && agentMode === "study");
    if (missing) setTab("general");
  }, [agentMode, tab]);

  if (!open) return null;
  const groups = navGroups(agentMode);

  return (
    <Modal open={open} onClose={() => setModal(null)} width={940}>
      <div className="settings">
        <aside className="settings-nav">
          <div className="settings-nav-title">设置</div>
          {groups.map((group) => (
            <div className="settings-nav-group" key={group.label}>
              <div className="settings-nav-group-label">{group.label}</div>
              {group.items.map((t) => (
                <button
                  key={t.id}
                  className={`settings-nav-item${tab === t.id ? " active" : ""}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </aside>
        <div className="settings-content">
          {tab === "general" && <GeneralTab />}
          {tab === "editor" && <EditorTab />}
          {tab === "reading" && <ReadingTab />}
          {tab === "focus" && <FocusTab />}
          {tab === "daily" && <DailyTab />}
          {tab === "templates" && <TemplatesTab />}
          {tab === "hotkeys" && <HotkeysTab />}
          {tab === "vim" && <VimTab />}
          {tab === "snippets" && <SnippetsTab />}
          {tab === "ime" && <ImeTab />}
          {tab === "quickadd" && <QuickAddTab />}
          {tab === "translate" && <TranslateTab />}
          {tab === "agent-model" && <AgentModelTab mode={agentMode} />}
          {tab === "agent-mcp" && agentMode !== "study" && (
            <AgentMcpTab mode={agentMode} workdir={workdir} />
          )}
          {tab === "agent-skills" && agentMode !== "study" && (
            <AgentSkillsTab mode={agentMode} workdir={workdir} />
          )}
          {tab === "agent-instructions" && (
            <AgentInstructionsTab mode={agentMode} workdir={workdir} />
          )}
          {tab === "agent-advanced" && agentMode === "coding" && (
            <AgentAdvancedTab mode={agentMode} workdir={workdir} />
          )}
        </div>
      </div>
    </Modal>
  );
}
