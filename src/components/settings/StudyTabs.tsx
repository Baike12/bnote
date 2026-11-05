import { useEffect, useState } from "react";
import { translateApi, type TranslateConfig } from "@/lib/tauri";
import { useAppStore } from "@/state/appStore";
import { SettingsCard, Row, SettingsSelect, Toggle } from "./primitives";

export function TranslateTab() {
  const showToast = useAppStore((s) => s.showToast);
  const enabled = useAppStore((s) => s.settings.studyTranslate.enabled);
  const patch = useAppStore((s) => s.patchSettings);
  const [cfg, setCfg] = useState<TranslateConfig | null>(null);
  const [extraJson, setExtraJson] = useState("{}");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [dictResult, setDictResult] = useState<string | null>(null);

  useEffect(() => {
    void translateApi
      .getConfig()
      .then((c) => {
        setCfg(c);
        setExtraJson(JSON.stringify(c.extra_body ?? {}, null, 2));
      })
      .catch((e) =>
        setLoadError(String(e).replace(/^[A-Z_]+:\s*/, "")),
      );
  }, []);

  if (!cfg) {
    return (
      <div className="settings-section">
        {loadError ? `翻译配置加载失败：${loadError}` : "加载中…"}
      </div>
    );
  }

  const preset = TRANSLATE_PROTOCOLS[cfg.protocol] ?? TRANSLATE_PROTOCOLS.openai;

  function update(patchCfg: Partial<TranslateConfig>) {
    setCfg((current) => (current ? { ...current, ...patchCfg } : current));
  }

  function changeProtocol(next: string) {
    const nextPreset = TRANSLATE_PROTOCOLS[next] ?? TRANSLATE_PROTOCOLS.openai;
    update({
      protocol: next,
      base_url: nextPreset.base,
      model: cfg!.model || nextPreset.model,
    });
    setTestResult(null);
  }

  function extraBody(): Record<string, unknown> {
    if (!extraJson.trim()) return {};
    const parsed: unknown = JSON.parse(extraJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("额外请求参数必须是 JSON 对象，例如 {}");
    }
    return parsed as Record<string, unknown>;
  }

  async function save() {
    setSaving(true);
    try {
      const extra_body = extraBody();
      await translateApi.saveConfig({ ...cfg!, extra_body });
      showToast("翻译 API 配置已保存");
    } catch (e) {
      showToast(`保存失败：${String(e).replace(/^[A-Z_]+:\s*/, "")}`);
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const extra_body = extraBody();
      const text = await translateApi.test({ ...cfg!, extra_body });
      setTestResult({ ok: true, text });
    } catch (e) {
      setTestResult({
        ok: false,
        text: String(e).replace(/^[A-Z_]+:\s*/, ""),
      });
    } finally {
      setTesting(false);
    }
  }

  async function testDictionary() {
    try {
      const result = await translateApi.selection("ubiquitous");
      if (result.kind === "word") {
        const first = result.entry.translation.split("\n")[0];
        setDictResult(
          `${result.entry.word} /${result.entry.phonetic}/ — ${first}`,
        );
      } else {
        setDictResult("未命中（内置词典未收录该词）");
      }
    } catch (e) {
      setDictResult(`查词失败：${String(e).replace(/^[A-Z_]+:\s*/, "")}`);
    }
  }

  return (
    <div className="settings-section">
      <SettingsCard
        title="学习模式正文选中翻译"
        desc="在 PDF 或网页正文里选中英文后显示译文卡片。单词只查内置词典；选中两个及以上单词才调用模型 API。"
      >
        <Toggle
          label="启用选中翻译"
          desc="关闭后 PDF 和网页都不响应选中。批注工具优先：进入高亮/文字批注后不会触发翻译。"
          checked={enabled}
          onChange={(v) =>
            patch({ studyTranslate: { ...useAppStore.getState().settings.studyTranslate, enabled: v } })
          }
        />
      </SettingsCard>

      <SettingsCard
        title="本地词典"
        desc="内置 ECDICT 常用词 59,137 条，离线查询；单词未收录时只提示，不会自动调用 API。想用模型翻译一个词，请把它和相邻词一起选中。"
        actions={
          <button className="btn" onClick={() => void testDictionary()}>
            测试查词
          </button>
        }
      >
        {dictResult && (
          <p className="setting-hint">{dictResult}</p>
        )}
        <p className="setting-hint">
          数据在编译期压缩进应用（约 1.5MB），首次使用时在内存中解压（约 4.3MB），
          不落盘、不依赖外部文件。
        </p>
      </SettingsCard>

      <SettingsCard
        title="句子翻译 API"
        desc="独立于学习助手配置，保存在 translate.json。请求由 Rust 发起；思考模式默认关闭。"
      >
        <Row
          label="协议"
          desc={preset.thinking}
          control={
            <SettingsSelect<string>
              value={cfg.protocol}
              onChange={changeProtocol}
            >
              {Object.entries(TRANSLATE_PROTOCOLS).map(([id, p]) => (
                <option key={id} value={id}>
                  {p.label}
                </option>
              ))}
            </SettingsSelect>
          }
        />
        <Row
          label="Base URL"
          desc="Ollama 填 http://127.0.0.1:11434（不要带 /v1）"
          control={
            <input
              className="settings-input mono"
              value={cfg.base_url}
              placeholder={preset.base}
              onChange={(e) => update({ base_url: e.target.value })}
            />
          }
        />
        <Row
          label="模型"
          control={
            <input
              className="settings-input"
              value={cfg.model}
              placeholder={preset.model || "模型名"}
              onChange={(e) => update({ model: e.target.value })}
            />
          }
        />
        <Row
          label="API Key"
          desc={cfg.protocol === "ollama" ? "本地 Ollama 忽略此项" : undefined}
          control={
            <input
              className="settings-input mono"
              type="password"
              value={cfg.api_key}
              onChange={(e) => update({ api_key: e.target.value })}
            />
          }
        />
        <Toggle
          label="开启思考模式"
          desc="默认关闭。关闭时按协议发送 think:false / thinking:{type:disabled} / enable_thinking:false；Anthropic 不发 thinking 字段。"
          checked={cfg.thinking}
          onChange={(v) => update({ thinking: v })}
        />
        <Row
          label="超时"
          desc="秒；超时后翻译卡片显示错误，不会重试。"
          control={
            <input
              className="settings-input mono"
              type="number"
              min={1}
              max={120}
              value={Math.round(cfg.timeout_ms / 1000)}
              onChange={(e) =>
                update({
                  timeout_ms:
                    Math.min(120, Math.max(1, Number(e.target.value) || 30)) *
                    1000,
                })
              }
            />
          }
        />
        <Row
          label="额外请求参数"
          desc='可选，JSON 对象。用于自定义网关；不能覆盖 messages/model/stream。'
          control={<span />}
        />
        <div className="settings-block">
          <textarea
            className="settings-textarea mono"
            rows={4}
            value={extraJson}
            onChange={(e) => setExtraJson(e.target.value)}
          />
        </div>
        <div className="settings-actions">
          <button className="btn" disabled={testing} onClick={() => void test()}>
            {testing ? "测试中…" : "测试连接"}
          </button>
          <button
            className="btn primary"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存翻译 API 配置"}
          </button>
        </div>
        {testResult && (
          <p
            className="setting-hint"
            style={{ color: testResult.ok ? "var(--ok)" : "var(--danger)" }}
          >
            {testResult.ok ? `连接成功：${testResult.text}` : testResult.text}
          </p>
        )}
      </SettingsCard>
    </div>
  );
}

const TRANSLATE_PROTOCOLS: Record<
  string,
  { label: string; base: string; model: string; thinking: string }
> = {
  ollama: {
    label: "Ollama（本地）",
    base: "http://127.0.0.1:11434",
    model: "qwen3:8b",
    thinking: "发送 think:false / think:true；本地服务忽略 API Key。",
  },
  openai: {
    label: "OpenAI 兼容",
    base: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    thinking: "不发送厂商私有思考字段；由模型选择或额外 JSON 控制。",
  },
  deepseek: {
    label: "DeepSeek",
    base: "https://api.deepseek.com",
    model: "deepseek-chat",
    thinking: "发送 thinking:{type:disabled}；开启后发 enabled。",
  },
  glm: {
    label: "智谱 GLM",
    base: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    thinking: "发送 thinking:{type:disabled}；GLM-5.3 / 5.3-FLASH 强制思考，关不掉。",
  },
  qwen: {
    label: "通义千问 Qwen",
    base: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    thinking: "发送 enable_thinking:false；开启后发 true。",
  },
  anthropic: {
    label: "Anthropic",
    base: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    thinking: "默认不发 thinking；开启后发 enabled + budget_tokens。",
  },
  custom: {
    label: "自定义 OpenAI 兼容",
    base: "",
    model: "",
    thinking: "思考开关不发字段；用额外请求参数传厂商字段。",
  },
};

/**
 * The config loading and saving shared by the four Agent sub-pages: one
 * agent.json, each page saves the fields it cares about (the whole package
 * is written, the backend normalize is the fallback). An already open
 * session runs with the snapshot it started with, so saving only affects
 * the sessions started afterwards.
 */
