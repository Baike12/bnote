import { templateLabel } from "@/templates/template";
import { SettingsSelect } from "./primitives";

export function TemplateSelect({
  value,
  files,
  dir,
  onChange,
}: {
  value: string;
  files: string[];
  dir: string;
  onChange: (template: string) => void;
}) {
  return (
    <SettingsSelect value={value} onChange={onChange}>
      <option value="">无模板</option>
      {files.map((file) => (
        <option key={file} value={file}>
          {templateLabel(file, dir)}
        </option>
      ))}
      {value !== "" && !files.includes(value) && (
        <option value={value}>{value}（不在当前模板目录）</option>
      )}
    </SettingsSelect>
  );
}

/** The rules of the template body (the daily note page and the template page share the same wording). */

export function TemplateHint() {
  return (
    <p className="setting-hint">
      模板是普通笔记文件，内容会原样写进新文件：<code>{"{{date}}"}</code>{" "}
      换成当天日期（YYYY-MM-DD），
      <code>{"{{title}}"}</code>{" "}
      换成新文件名（日记里是日期），其它文字照抄。改完模板文件，下次创建立即生效。
    </p>
  );
}
