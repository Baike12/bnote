import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import {
  remoteApi,
  type RemoteAuditEntry,
  type RemoteDevice,
  type RemoteStatus,
} from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { useRemoteStore } from "@/remote/store";
import { SettingsCard, Row, Toggle } from "./primitives";

const KIND_LABEL: Record<string, string> = {
  send: "发送",
  permission: "审批",
  abort: "中止",
  rollback: "回滚",
  pair: "配对",
  revoke: "吊销",
  system: "系统",
};

function cleanError(error: unknown): string {
  return String(error).replace(/^[A-Z_]+:\s*/, "");
}

/**
 * Remote access: the channel to the iPhone, pairing and the device list.
 *
 * The page is the only place that produces a QR; the backend owns the room,
 * the host token and the device records, so closing this page changes nothing.
 */
export function RemoteTab() {
  const showToast = useAppStore((s) => s.showToast);
  const codeProject = useAppStore((s) => s.codeProject);
  const pendingPair = useRemoteStore((s) => s.pendingPair);
  const setPendingPair = useRemoteStore((s) => s.setPendingPair);

  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [relayUrl, setRelayUrl] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  const [pairExpires, setPairExpires] = useState<number | null>(null);
  const [projectInput, setProjectInput] = useState("");
  const [audit, setAudit] = useState<RemoteAuditEntry[] | null>(null);
  const [todoServer, setTodoServer] = useState("https://101.96.243.197/b-todo");
  const [todoKey, setTodoKey] = useState("");
  const [todoDevice, setTodoDevice] = useState("");

  const refresh = useCallback(async () => {
    try {
      const next = await remoteApi.status();
      setStatus(next);
      setRelayUrl((current) => (current === "" ? next.relayUrl : current));
      setLoadError(null);
    } catch (e) {
      setLoadError(cleanError(e));
    }
  }, []);

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

  async function toggleEnabled(next: boolean) {
    await run(
      async () => {
        const value = await remoteApi.setEnabled(next, relayUrl.trim() || undefined);
        setStatus(value);
      },
      next ? "远程访问已启用" : "远程访问已关闭",
    );
  }

  async function saveRelay() {
    if (!status) return;
    await run(async () => {
      const value = await remoteApi.setEnabled(status.enabled, relayUrl.trim());
      setStatus(value);
    }, "中继地址已保存");
  }

  async function beginPairing() {
    setBusy(true);
    try {
      const offer = await remoteApi.pairingBegin();
      setQr(await QRCode.toDataURL(offer.payload, { margin: 1, width: 260 }));
      setPairExpires(offer.expiresAt);
      await refresh();
    } catch (e) {
      showToast(cleanError(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancelPairing() {
    setQr(null);
    setPairExpires(null);
    await remoteApi.pairingCancel().catch(() => undefined);
  }

  async function answerPair(allow: boolean) {
    if (!pendingPair) return;
    const deviceId = pendingPair.deviceId;
    setPendingPair(null);
    await run(() => remoteApi.pairApprove(deviceId, allow), allow ? "已允许配对" : "已拒绝配对");
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

  async function sendTodoConfig() {
    if (!todoDevice) {
      showToast("先选择一台设备");
      return;
    }
    await run(
      () => remoteApi.todoConfig(todoDevice, todoServer.trim(), todoKey.trim()),
      "已通过加密通道发送待办配置",
    );
    setTodoKey("");
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

  const devices: RemoteDevice[] = status.devices;
  const active = status.enabled;
  const pairingExpired = pairExpires != null && pairExpires < Date.now();

  return (
    <div className="settings-section">
      <SettingsCard
        title="远程访问"
        desc="iPhone 通过自建中继连接这台 Mac；中继只转发密文，看不到对话与代码。"
      >
        <Toggle
          label="启用远程访问"
          desc={
            active
              ? `状态：${
                  status.status === "online"
                    ? "已连接"
                    : status.status === "connecting"
                      ? "连接中"
                      : "未连接（会自动重试）"
                }${status.lastError ? ` · ${status.lastError}` : ""}`
              : "关闭时不会建立任何连接"
          }
          checked={active}
          disabled={busy}
          onChange={(v) => void toggleEnabled(v)}
        />
        <Row
          label="中继地址"
          desc="必须是 wss://；证书固定在 App 内，更换证书需要重新构建。"
          control={
            <div className="remote-inline">
              <input
                className="settings-input"
                value={relayUrl}
                spellCheck={false}
                onChange={(e) => setRelayUrl(e.target.value)}
              />
              <button className="settings-btn" disabled={busy} onClick={() => void saveRelay()}>
                保存
              </button>
            </div>
          }
        />
      </SettingsCard>

      <SettingsCard
        title="配对手机"
        desc="二维码 5 分钟内有效，且只能使用一次；生成前请确认中继已连接。"
        actions={
          <button
            className="settings-btn"
            disabled={!active || busy}
            onClick={() => void beginPairing()}
          >
            生成配对二维码
          </button>
        }
      >
        {pendingPair && (
          <div className="remote-pair-request">
            <div>
              <strong>{pendingPair.name}</strong> 请求配对这台 Mac
            </div>
            <div className="settings-inline-actions">
              <button className="settings-btn" onClick={() => void answerPair(true)}>
                允许
              </button>
              <button className="settings-btn" onClick={() => void answerPair(false)}>
                拒绝
              </button>
            </div>
          </div>
        )}
        {qr ? (
          <div className="remote-qr">
            <img src={qr} width={260} height={260} alt="配对二维码" />
            <div className="settings-desc">
              {pairingExpired
                ? "二维码已过期，请重新生成"
                : `有效期至 ${new Date(pairExpires ?? 0).toLocaleTimeString("zh-CN")}`}
            </div>
            <button className="settings-btn" onClick={() => void cancelPairing()}>
              收起
            </button>
          </div>
        ) : (
          !pendingPair && <div className="settings-empty">尚未生成配对二维码</div>
        )}
      </SettingsCard>

      <SettingsCard title="已配对设备" desc="吊销只切断中继与代码通道，不回收已经下发的待办密钥。">
        {devices.length === 0 ? (
          <div className="settings-empty">还没有设备</div>
        ) : (
          devices.map((device) => (
            <Row
              key={device.deviceId}
              label={device.name}
              desc={`${device.revoked ? "已吊销" : "已授权"} · 最近活跃 ${
                device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString("zh-CN") : "从未"
              }`}
              control={
                device.revoked ? null : (
                  <button
                    className="settings-btn"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`吊销「${device.name}」？`)) return;
                      void run(() => remoteApi.revokeDevice(device.deviceId), "设备已吊销");
                    }}
                  >
                    吊销
                  </button>
                )
              }
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
        title="待办配置"
        desc="服务器地址与密钥通过已建立的加密通道下发；密钥只进入手机的 Keychain。"
      >
        <Row
          label="服务器"
          control={
            <input
              className="settings-input"
              value={todoServer}
              spellCheck={false}
              onChange={(e) => setTodoServer(e.target.value)}
            />
          }
        />
        <Row
          label="密钥"
          desc="与网页版相同的一串密钥；不会写入 Mac 的审计日志。"
          control={
            <input
              className="settings-input"
              type="password"
              value={todoKey}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setTodoKey(e.target.value)}
            />
          }
        />
        <Row
          label="发送到"
          control={
            <div className="remote-inline">
              <select
                className="settings-input"
                value={todoDevice}
                onChange={(e) => setTodoDevice(e.target.value)}
              >
                <option value="">选择设备</option>
                {devices
                  .filter((d) => !d.revoked)
                  .map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.name}
                    </option>
                  ))}
              </select>
              <button
                className="settings-btn"
                disabled={busy || !todoKey.trim()}
                onClick={() => void sendTodoConfig()}
              >
                发送
              </button>
            </div>
          }
        />
      </SettingsCard>

      <SettingsCard
        title="审计日志"
        desc="只保存在这台 Mac 上；记录发送摘要、审批、吊销与配对，不记录 API Key。"
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
