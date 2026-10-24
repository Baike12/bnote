import { useAppStore } from "@/state/appStore";

/**
 * 学习模式右栏的页签:笔记 / 学习助手。
 * 两栏(StudyLayout 与 AgentPanel 的头部)共用这一份,避免两处手写失同步。
 */
export function StudyRightTabs() {
  const tab = useAppStore((s) => s.settings.studyRightTab);
  const patch = useAppStore((s) => s.patchSettings);
  return (
    <div className="study-tabs" role="tablist" aria-label="右栏页签">
      <button
        className={`study-tab${tab === "notes" ? " active" : ""}`}
        role="tab"
        aria-selected={tab === "notes"}
        title="笔记页(⌘⇧U 切换)"
        onClick={() => patch({ studyRightTab: "notes" })}
      >
        笔记
      </button>
      <button
        className={`study-tab${tab === "agent" ? " active" : ""}`}
        role="tab"
        aria-selected={tab === "agent"}
        title="学习助手(⌘⇧U 切换)"
        onClick={() => patch({ studyRightTab: "agent" })}
      >
        学习助手
      </button>
    </div>
  );
}
