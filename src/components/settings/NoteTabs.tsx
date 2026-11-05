import { useMemo } from "react";
import { useAppStore } from "@/state/appStore";
import { FolderSuggest } from "@/components/FolderSuggest";
import { normalizeTemplateDir, templateFiles, templateLabel } from "@/templates/template";
import { SettingsCard, Row } from "./primitives";
import { TemplateSelect, TemplateHint } from "./TemplateSelect";

export function DailyTab() {
  const daily = useAppStore((s) => s.settings.daily);
  const templatesDir = useAppStore((s) => s.settings.templatesDir);
  const flatFiles = useAppStore((s) => s.flatFiles);
  const patch = useAppStore((s) => s.patchSettings);
  const templates = useMemo(
    () => templateFiles(flatFiles, templatesDir),
    [flatFiles, templatesDir],
  );

  return (
    <div className="settings-section">
      <SettingsCard
        title="日记模板"
        desc="新建日记时用这份模板生成初始内容（⌘⇧O 打开今日日记、快速待办、项目发送、日记栏四个入口共用）；不选则默认以「# 日期」开篇。"
      >
        <Row
          label="模板文件"
          desc={
            templates.length > 0
              ? "模板来自「模板」页设置的目录。日记的待办区紧跟在首个 H1 之后；模板没有 H1 时待办顶到文件最前。"
              : "还没有可用模板：先到「模板」页设置模板目录并放入模板笔记。"
          }
          control={
            <TemplateSelect
              value={daily.template}
              files={templates}
              dir={templatesDir}
              onChange={(template) => patch({ daily: { ...daily, template } })}
            />
          }
        />
      </SettingsCard>
      <TemplateHint />
    </div>
  );
}

export function TemplatesTab() {
  const dir = useAppStore((s) => s.settings.templatesDir);
  const flatFiles = useAppStore((s) => s.flatFiles);
  const patch = useAppStore((s) => s.patchSettings);
  const templates = useMemo(() => templateFiles(flatFiles, dir), [flatFiles, dir]);

  return (
    <div className="settings-section">
      <SettingsCard
        title="模板目录"
        desc="快速添加命令与日记都可以选用这个目录里的文件作为模板（含子目录）。目录不存在时先选择一个已有文件夹。"
      >
        <div className="settings-block">
          <FolderSuggest
            className="settings-input mono"
            placeholder="模板文件夹，如 Templates"
            value={dir}
            onChange={(templatesDir) => patch({ templatesDir })}
          />
          <div className="qa-empty">
            {normalizeTemplateDir(dir)
              ? templates.length > 0
                ? `找到 ${templates.length} 个模板`
                : "目录里还没有笔记文件"
              : "还没有设置模板目录"}
          </div>
        </div>
      </SettingsCard>
      {templates.length > 0 && (
        <SettingsCard title="可用模板">
          <div className="settings-block">
            {templates.map((file) => (
              <div className="setting-value" key={file}>
                {templateLabel(file, dir)}
              </div>
            ))}
          </div>
        </SettingsCard>
      )}
      <TemplateHint />
    </div>
  );
}
