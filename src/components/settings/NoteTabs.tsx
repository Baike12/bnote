import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/state/appStore";
import { FolderSuggest } from "@/components/FolderSuggest";
import { syncApi } from "@/lib/tauri";
import { normalizeTemplateDir, templateFiles, templateLabel } from "@/templates/template";
import {
  configureSync,
  forcePullAll,
  forcePushAll,
  onSyncChanged,
  syncRuntime,
} from "@/daily/sync/sync";
import { SettingsCard, Row, Toggle } from "./primitives";
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
      <SyncCard />
      <TemplateHint />
    </div>
  );
}

/** 多端同步（b-todo）：开关关闭时不建立任何连接，本地使用完全不受影响。 */
function SyncCard() {
  const daily = useAppStore((s) => s.settings.daily);
  const patch = useAppStore((s) => s.patchSettings);
  const [, forceRender] = useState(0);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState<"" | "push" | "pull">("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => onSyncChanged(() => forceRender((n) => n + 1)), []);

  const sync = daily.sync;
  const patchSync = (part: Partial<typeof sync>) => {
    patch({ daily: { ...daily, sync: { ...sync, ...part } } });
  };
  const runtime = syncRuntime();

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const message = await syncApi.test(sync.server, sync.key);
      setResult({ ok: true, text: message });
    } catch (e) {
      setResult({ ok: false, text: String(e).replace(/^[A-Z_]+:\s*/, "") });
    } finally {
      setTesting(false);
    }
  };

  const connect = async () => {
    setResult(null);
    await configureSync();
    const after = syncRuntime();
    setResult({
      ok: after.connected,
      text: after.connected ? "已连接服务器" : `连接失败：${after.detail}`,
    });
  };

  const forcePush = async () => {
    setBusy("push");
    try {
      await forcePushAll();
      setResult({ ok: true, text: "已用本地日记覆盖服务器全部记录" });
    } catch (e) {
      setResult({
        ok: false,
        text: e instanceof Error ? e.message : String(e).replace(/^[A-Z_]+:\s*/, ""),
      });
    } finally {
      setBusy("");
    }
  };

  const forcePull = async () => {
    setBusy("pull");
    try {
      await forcePullAll();
      const after = syncRuntime();
      setResult({ ok: true, text: `已用服务器覆盖本地（${after.detail || "完成"}）` });
    } catch (e) {
      setResult({
        ok: false,
        text: e instanceof Error ? e.message : String(e).replace(/^[A-Z_]+:\s*/, ""),
      });
    } finally {
      setBusy("");
    }
  };

  return (
    <SettingsCard
      title="多端同步"
      desc="把 Daily/ 下的日记与 b-todo 服务器做发布订阅式同步（改动实时互推）；内容端到端加密，服务器只存密文。关闭时不建立任何网络连接。"
    >
      <Row
        label="启用同步"
        desc="关闭后完全本地使用；开启后自动连接并同步日记"
        control={
          <Toggle
            label="启用同步"
            checked={sync.enabled}
            onChange={(enabled) => {
              patchSync({ enabled });
              void configureSync();
            }}
          />
        }
      />
      <Row
        label="服务器地址"
        desc="b-todo 服务端地址；裸 IP 默认按 http 处理"
        control={
          <input
            className="settings-input mono"
            type="text"
            placeholder="http://101.96.243.197/b-todo"
            value={sync.server}
            onChange={(e) => patchSync({ server: e.target.value })}
          />
        }
      />
      <Row
        label="同步密钥"
        desc="部署服务器时生成的那把密钥；只保存在本地 config.json，网络上只出现它派生出的凭证"
        control={
          <input
            className="settings-input mono"
            type="password"
            placeholder="openssl rand -hex 24 生成的密钥"
            value={sync.key}
            onChange={(e) => patchSync({ key: e.target.value })}
          />
        }
      />
      <div className="settings-actions">
        <button
          className="btn"
          disabled={testing || sync.server.trim() === "" || sync.key.trim() === ""}
          onClick={() => void test()}
        >
          {testing ? "测试中…" : "测试连接"}
        </button>
        <button
          className="btn primary"
          disabled={sync.server.trim() === "" || sync.key.trim() === ""}
          onClick={() => void connect()}
        >
          保存并连接
        </button>
        {sync.enabled && (
          <>
            <button
              className="btn"
              disabled={busy !== ""}
              onClick={() => {
                if (
                  window.confirm("确定用本地日记覆盖服务器上所有天的记录？其他端的修改会被覆盖。")
                ) {
                  void forcePush();
                }
              }}
            >
              {busy === "push" ? "推送中…" : "强制推送（本地覆盖）"}
            </button>
            <button
              className="btn"
              disabled={busy !== ""}
              onClick={() => {
                if (window.confirm("确定用服务器覆盖本地所有日记？本地未同步的修改会被覆盖。")) {
                  void forcePull();
                }
              }}
            >
              {busy === "pull" ? "拉取中…" : "强制拉取（服务器覆盖）"}
            </button>
          </>
        )}
      </div>
      {result && <p className={`setting-hint${result.ok ? " ok" : " err"}`}>{result.text}</p>}
      {sync.enabled && (
        <p className="setting-hint">
          状态：{runtime.connected ? "已连接" : runtime.detail || "未连接"}
          {runtime.lastSyncAt !== null &&
            ` · 最后同步 ${new Date(runtime.lastSyncAt).toLocaleTimeString()}`}
          {runtime.unresolvedCount > 0 &&
            ` · ${runtime.unresolvedCount} 天存在冲突，请用强制同步选择一侧`}
        </p>
      )}
    </SettingsCard>
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
