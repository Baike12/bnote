import { useCallback, useEffect, useState } from "react";
import { remoteApi, type RemoteAuditEntry, type RemoteStatus } from "@/lib/tauri";
import { writeClipboardText } from "@/lib/clipboard";
import { useAppStore } from "@/state/appStore";
import { useRemoteStore } from "@/remote/store";
import { SettingsCard, Row, Toggle } from "./primitives";

const KIND_LABEL: Record<string, string> = {
  send: "发送",
  permission: "审批",
  abort: "中止",
  rollback: "回滚",
  connect: "连接",
  key: "密钥",
  system: "系统",
};

function cleanError(error: unknown): string {
  return String(error).replace(/^[A-Z_]+:\s*/, "");
}

function formatTime(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString("zh-CN") : "—";
}

/**
 * Remote access: one service base URL, one remote key, and a read-only view of
 * the phones currently attached. The backend owns the socket and the keys;
 * this page never holds the key after the one-time reveal.
 */
export function RemoteTab() {
  const showToast = useAppStore((s) => s.showToast);
  const codeProject = useAppStore((s) => s.codeProject);
  const daily = useAppStore((s) => s.settings.daily);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const liveStatus = useRemoteStore((s) => s.status);
  const liveError = useRemoteStore((s) => s.lastError);

  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [baseUrlTouched, setBaseUrlTouched] = useState(false);
  const [shownKey, setShownKey] = useState<string | null>(null);
  const [projectInput, setProjectInput] = useState("");
  const [audit, setAudit] = useState<RemoteAuditEntry[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await remoteApi.status();
      setStatus(next);
      setBaseUrl((current) => (baseUrlTouched ? current : next.baseUrl));
      setLoadError(null);
    } catch (e) {
      setLoadError(cleanError(e));
    }
  }, [baseUrlTouched]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function run(action: () => Promise<unknown>, success?: string): Promise<void> {
    setBusy(true);
    try {
      await action();
      if (success) showToast(success);
      await refresh();
    } catch (e) {
      showToast(cleanError(e));
    } finally {
      setBusy(false);
    }
  }

  /** The todo sync client always uses the server derived from the base URL. */
  function writeDerivedServer(next: RemoteStatus): void {
    patchSettings({
      daily: { ...daily, sync: { ...daily.sync, server: `${next.baseUrl}/todo` } },
    });
  }

  async function toggleEnabled(next: boolean) {
    await run(
      async () => {
        const value = await remoteApi.setEnabled(next);
        setStatus(value);
        if (value.newKey) setShownKey(value.newKey);
        writeDerivedServer(value);
      },
      next ? "远程访问已启用" : "远程访问已关闭",
    );
  }

  async function saveBaseUrl() {
    await run(async () => {
      const value = await remoteApi.setBaseUrl(baseUrl.trim());
      setBaseUrl(value.baseUrl);
      setBaseUrlTouched(false);
      setStatus(value);
      writeDerivedServer(value);
    }, "服务地址已保存");
  }

  async function generateKey() {
    await run(async () => {
      const value = await remoteApi.keyGenerate();
      setShownKey(value.key);
    }, "远程密钥已生成");
  }

  async function revealKey(show: boolean) {
    try {
      const value = await remoteApi.keyReveal();
      if (show) setShownKey(value.key);
      else await writeClipboardText(value.key);
      if (!show) showToast("远程密钥已复制");
    } catch (e) {
      showToast(cleanError(e));
    }
  }

  async function copyShownKey() {
    if (!shownKey) return;
    await writeClipboardText(shownKey);
    showToast("远程密钥已复制");
  }

  async function rotateKey() {
    if (!window.confirm("轮换后所有手机立即失效，需要用新密钥重新填写。继续？")) return;
    await run(async () => {
      const value = await remoteApi.keyRotate();
      setShownKey(value.key);
    }, "远程密钥已轮换");
  }

  async function addProject() {
    if (!status) return;
    const value = projectInput.trim();
    if (!value) return;
    const next = [...status.allowedProjects, value];
    await run(async () => {
      const saved = await remoteApi.setAllowedProjects(next);
      setStatus({ ...status, allowedProjects: saved.allowedProjects });
    }, "已添加项目");
    setProjectInput("");
  }

  async function removeProject(path: string) {
    if (!status) return;
    await run(async () => {
      const saved = await remoteApi.setAllowedProjects(
        status.allowedProjects.filter((p) => p !== path),
      );
      setStatus({ ...status, allowedProjects: saved.allowedProjects });
    });
  }

  async function loadAudit() {
    try {
      const value = await remoteApi.auditTail(100);
      setAudit(value.entries);
    } catch (e) {
      showToast(cleanError(e));
    }
  }

  if (!status) {
    return (
      <div className="settings-section">
        <div className="settings-empty">
          {loadError ? `远程访问配置加载失败：${loadError}` : "加载中…"}
        </div>
      </div>
    );
  }

  const active = status.enabled;
  // The store receives push events between polls; prefer them when present.
  const state = active ? (liveStatus === "disabled" ? status.status : liveStatus) : "disabled";
  const stateLabel =
    state === "online"
      ? "已连接"
      : state === "connecting"
        ? "连接中"
        : state === "disabled"
          ? "已关闭"
          : "未连接（会自动重试）";
  const error = liveError ?? status.lastError;

  return (
    <div className="settings-section">
      <SettingsCard
        title="远程访问"
        desc="iPhone 与这台 Mac 通过同一个服务的 relay 连接；relay 只转发密文，看不到对话与代码。"
      >
        <Toggle
          label="启用远程访问"
          desc={
            active ? `状态：${stateLabel}${error ? ` · ${error}` : ""}` : "关闭时不会建立任何连接"
          }
          checked={active}
          disabled={busy}
          onChange={(v) => void toggleEnabled(v)}
        />
        <Row
          label="服务地址"
          desc={`待办与远程都从这里派生：${baseUrl || status.baseUrl}/todo、${
            status.relayUrl ?? "—"
          }。TLS 使用系统信任，换证书不需要重装 App。`}
          control={
            <div className="remote-inline">
              <input
                className="settings-input mono"
                value={baseUrl}
                spellCheck={false}
                placeholder="https://realbaike.tech/bnote"
                onChange={(e) => {
                  setBaseUrlTouched(true);
                  setBaseUrl(e.target.value);
                }}
              />
              <button
                className="settings-btn"
                disabled={busy || !baseUrlTouched}
                onClick={() => void saveBaseUrl()}
              >
                保存
              </button>
            </div>
          }
        />
      </SettingsCard>

      <SettingsCard
        title="远程密钥"
        desc="手机设置里粘贴同一把 key。它是远程访问的唯一凭证；只有轮换才能吊销手机，待办密钥与日记不受影响。"
      >
        {shownKey ? (
          <div className="remote-key">
            <code className="remote-key-value">{shownKey}</code>
            <div className="settings-inline-actions">
              <button className="settings-btn" onClick={() => void copyShownKey()}>
                复制
              </button>
              <button className="settings-btn" onClick={() => setShownKey(null)}>
                收起
              </button>
            </div>
            <div className="settings-desc">这把 key 只显示这一次，请粘贴到手机设置。</div>
          </div>
        ) : status.hasKey ? (
          <Row
            label={`已设置 · ****${status.keySuffix ?? "????"}`}
            desc="完整的 key 只保存在这台 Mac 的钥匙串里，状态接口只返回末四位。"
            control={
              <div className="remote-inline">
                <button className="settings-btn" onClick={() => void revealKey(true)}>
                  显示
                </button>
                <button className="settings-btn" onClick={() => void revealKey(false)}>
                  复制
                </button>
                <button className="settings-btn" disabled={busy} onClick={() => void rotateKey()}>
                  轮换
                </button>
              </div>
            }
          />
        ) : (
          <div className="settings-inline-actions">
            <button className="settings-btn" disabled={busy} onClick={() => void generateKey()}>
              生成远程密钥
            </button>
            <span className="settings-desc">启用远程访问时也会自动生成。</span>
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title="最近连接"
        desc="只读：手机自报的名称与设备 id 不是认证身份，这里不提供单设备吊销。"
        actions={
          <button className="settings-btn" onClick={() => void refresh()}>
            刷新
          </button>
        }
      >
        {status.connections.length === 0 ? (
          <div className="settings-empty">当前没有已连接的手机</div>
        ) : (
          status.connections.map((connection) => (
            <Row
              key={connection.deviceId}
              label={connection.name}
              desc={`连接于 ${formatTime(connection.connectedAt)} · 最近活跃 ${formatTime(
                connection.lastSeenAt,
              )} · ${connection.deviceId}`}
            />
          ))
        )}
      </SettingsCard>

      <SettingsCard
        title="允许的项目"
        desc="手机只能看到并驱动这里列出的代码项目；路径在 Mac 上解析，手机只收到不透明的项目 id。"
      >
        {status.allowedProjects.length === 0 ? (
          <div className="settings-empty">还没有允许的项目</div>
        ) : (
          status.allowedProjects.map((path) => (
            <Row
              key={path}
              label={path.split("/").filter(Boolean).pop() ?? path}
              desc={path}
              control={
                <button
                  className="settings-btn"
                  disabled={busy}
                  onClick={() => void removeProject(path)}
                >
                  移除
                </button>
              }
            />
          ))
        )}
        <Row
          label="添加项目"
          control={
            <div className="remote-inline">
              <input
                className="settings-input"
                placeholder="/Users/you/project"
                value={projectInput}
                spellCheck={false}
                onChange={(e) => setProjectInput(e.target.value)}
              />
              <button className="settings-btn" disabled={busy} onClick={() => void addProject()}>
                添加
              </button>
              {codeProject?.path && (
                <button
                  className="settings-btn"
                  disabled={busy}
                  onClick={() => {
                    setProjectInput(codeProject.path);
                    void (async () => {
                      const saved = await remoteApi
                        .setAllowedProjects([...status.allowedProjects, codeProject.path])
                        .catch((e) => {
                          showToast(cleanError(e));
                          return null;
                        });
                      if (saved) {
                        setStatus({ ...status, allowedProjects: saved.allowedProjects });
                        setProjectInput("");
                        showToast("已添加当前项目");
                      }
                    })();
                  }}
                >
                  加入当前项目
                </button>
              )}
            </div>
          }
        />
      </SettingsCard>

      <SettingsCard
        title="审计日志"
        desc="只保存在这台 Mac 上；记录连接、密钥变更与发送摘要，不记录 API Key。"
        actions={
          <button className="settings-btn" onClick={() => void loadAudit()}>
            加载最近 100 条
          </button>
        }
      >
        {audit === null ? (
          <div className="settings-empty">尚未加载</div>
        ) : audit.length === 0 ? (
          <div className="settings-empty">没有记录</div>
        ) : (
          <div className="remote-audit">
            {audit.map((entry, index) => (
              <div className="remote-audit-row" key={`${entry.at}-${index}`}>
                <span className="remote-audit-time">
                  {new Date(entry.at).toLocaleString("zh-CN")}
                </span>
                <span className="remote-audit-kind">{KIND_LABEL[entry.kind] ?? entry.kind}</span>
                <span className="remote-audit-summary">{entry.summary}</span>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>
    </div>
  );
}
