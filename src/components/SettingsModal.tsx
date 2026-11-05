import { useState } from "react";
import { useAppStore } from "@/state/appStore";
import { Modal } from "./Modal";
import { NAV_GROUPS, type Tab } from "./settings/nav";
import { GeneralTab, EditorTab, ReadingTab } from "./settings/GeneralTabs";
import { FocusTab } from "./settings/FocusTab";
import { HotkeysTab, VimTab, SnippetsTab, ImeTab, QuickAddTab } from "./settings/InputTabs";
import { DailyTab, TemplatesTab } from "./settings/NoteTabs";
import { TranslateTab } from "./settings/StudyTabs";
import {
  AgentModelTab,
  AgentMcpTab,
  AgentSkillsTab,
  AgentInstructionsTab,
  AgentSettingsTab,
} from "./settings/AgentTabs";

/**
 * The settings window: a grouped navigation on the left, the section of the
 * selected tab on the right. Each section owns its card layout and state;
 * this file only maps a tab id to its component.
 */
export function SettingsModal() {
  const open = useAppStore((s) => s.modal === "settings");
  const setModal = useAppStore((s) => s.setModal);
  const [tab, setTab] = useState<Tab>("general");
  if (!open) return null;

  return (
    <Modal open={open} onClose={() => setModal(null)} width={940}>
      <div className="settings">
        <aside className="settings-nav">
          <div className="settings-nav-title">设置</div>
          {NAV_GROUPS.map((group) => (
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
          {tab === "agent-model" && <AgentModelTab />}
          {tab === "agent-mcp" && <AgentMcpTab />}
          {tab === "agent-skills" && <AgentSkillsTab />}
          {tab === "agent-instructions" && <AgentInstructionsTab />}
          {tab === "agent-settings" && <AgentSettingsTab />}
        </div>
      </div>
    </Modal>
  );
}
