import { describe, expect, it } from "vitest";
// @ts-expect-error type error without @types/node package
import { readFileSync } from "node:fs";

/**
 * 会话恢复/分叉/标题的接线门禁。
 *
 * 这里锁的是「谁来调用谁」这类编译期看不见的约束:
 * - 重启恢复必须走会话家族(根=主会话),不能退回「只挂最近更新那一条」;
 * - 切到家族里未启动的会话要懒启动,而不是裸 setActiveKey;
 * - 分叉必须把父子关系写进记录文件(重启后唯一的还原依据);
 * - 标题必须来自会话自己的第一句话,且只请求一次、写回文件。
 *
 * 纯逻辑(sessionTree / sessionTitle / transcript)另有单测;这里只保证
 * AgentPanel 确实按那条路径接线。
 */

const raw = readFileSync("src/components/AgentPanel.tsx", "utf8");
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

describe("重启恢复:会话家族而不是最近一条", () => {
  it("生命周期恢复调用 restoreFamily(..., \"root\")", () => {
    expect(code).toMatch(/restoreFamily\(sessions\[0\]\.id,\s*sessions,\s*"root"\)/);
  });

  it("不再有只挂单条会话的 openSavedSession 路径", () => {
    expect(code).not.toMatch(/openSavedSession/);
    const fn = code.slice(code.indexOf("const restoreFamily = useCallback"));
    const body = fn.slice(0, fn.indexOf("const activateConv"));
    // 家族恢复必须整表替换;单条 setConvs([conv]) 只允许出现在「新建主会话」。
    expect(body).toMatch(/setConvs\(convs\)/);
    expect(body).not.toMatch(/setConvs\(\[conv\]\)/);
  });

  it("只启动落点那一条(后端会话单飞,同时开两条会互相作废)", () => {
    const body = code.slice(code.indexOf("const restoreFamily = useCallback"));
    const fn = body.slice(0, body.indexOf("const activateConv"));
    expect(fn).toMatch(/const focusKey = activate === "anchor"/);
    expect(fn).toMatch(/launchRestored\(focus, token\)/);
    // 只允许一次 launchRestored 调用(根与落点不各开一条)。
    expect(fn.match(/launchRestored\(/g)?.length ?? 0).toBe(1);
  });

  it("家族成员从 parent 映射回内存 key(重启后 parent 是文件 id)", () => {
    expect(code).toMatch(/parent: member\.parent \? \(keyByFile\.get\(member\.parent\) \?\? null\)/);
  });
});

describe("会话切换:懒启动", () => {
  it("头部选择与返回都走 activateConv", () => {
    expect(code).toMatch(/onSelect=\{activateConv\}/);
    expect(code).toMatch(/onBack=\{\(\) => parentConv && activateConv\(parentConv\.key\)\}/);
  });

  it("activateConv 对未启动的会话读盘并起后端会话", () => {
    const body = code.slice(code.indexOf("const activateConv = useCallback"));
    const fn = body.slice(0, body.indexOf("const generateTitle"));
    expect(fn).toMatch(/conv\.sessionId \|\| !conv\.transcriptPath/);
    expect(fn).toMatch(/lazyStartingRef\.current\.has\(key\)/);
    expect(fn).toMatch(/launchRestored\(conv, restoreTokenRef\.current\)/);
  });

  it("⌘⇧Y 切换与命令面板返回都走 activateConv(不再裸 setActiveKey)", () => {
    const start = code.indexOf("if (agentSwitchSignal === 0) return;");
    const switchEffect = code.slice(start, code.indexOf("}, [agentSwitchSignal", start));
    expect(switchEffect).toMatch(/activateConv\(next\)/);
    expect(switchEffect).not.toMatch(/setActiveKey/);
  });

  it("恢复代守卫:读盘回来时 token 变了就放弃", () => {
    const fn = code.slice(code.indexOf("const launchRestored = useCallback"));
    expect(fn.slice(0, fn.indexOf("const restoreFamily"))).toMatch(
      /if \(restoreTokenRef\.current !== token\) return;/,
    );
  });
});

describe("分叉:父子关系落盘", () => {
  it("新会话的 Conv 记录 forkAt 与标题来源", () => {
    const fn = code.slice(code.indexOf("const forkFrom = useCallback"));
    const body = fn.slice(0, fn.indexOf("const parentConv"));
    expect(body).toMatch(/forkAt: prefix\.length/);
    expect(body).toMatch(/titleSource: "first-message"/);
  });

  it("startSession 收到 forkMeta:父会话文件 id、来源摘要、前缀条数", () => {
    const fn = code.slice(code.indexOf("const forkFrom = useCallback"));
    const body = fn.slice(0, fn.indexOf("const parentConv"));
    expect(body).toMatch(/forkMeta: \{[\s\S]*parent: src\.sessionFileId/);
    expect(body).toMatch(/basedOn: conv\.basedOn/);
    expect(body).toMatch(/forkAt: prefix\.length/);
  });

  it("分叉写盘时把 forkMeta 传给 buildSessionMeta", () => {
    expect(code).toMatch(/parent: opts\.forkMeta\?\.parent \?\? null/);
    expect(code).toMatch(/basedOn: opts\.forkMeta\?\.basedOn/);
    expect(code).toMatch(/forkAt: opts\.forkMeta\?\.forkAt/);
  });
});

describe("标题:会话自己的第一句话,模型生成一次并落盘", () => {
  it("首轮发送时记下 seed,且已经 LLM 命名的会话不再记", () => {
    expect(code).toMatch(
      /conv\.titleSource !== "llm" && !titleSeedRef\.current\.has\(conv\.key\)/,
    );
    expect(code).toMatch(/titleSeedRef\.current\.set\(conv\.key,/);
  });

  it("turn_end 成功后触发,且 seed 用过即删", () => {
    const turnEnd = code.slice(code.indexOf('case "turn_end"'));
    const body = turnEnd.slice(0, turnEnd.indexOf('case "error"'));
    expect(body).toMatch(/titleSeedRef\.current\.get\(conv\.key\)/);
    expect(body).toMatch(/titleSeedRef\.current\.delete\(conv\.key\)/);
    expect(body).toMatch(/generateTitle\(conv\.key, seed\)/);
  });

  it("失败的一轮不触发(保持本地兜底标题)", () => {
    const errCase = code.slice(code.indexOf('case "error"'));
    const body = errCase.slice(0, errCase.indexOf("requestAnimationFrame"));
    expect(body).not.toMatch(/generateTitle/);
  });

  it("只请求一次;标题从清洗到层级前缀再到写回文件", () => {
    const fn = code.slice(code.indexOf("const generateTitle = useCallback"));
    const body = fn.slice(0, fn.indexOf("// 主会话生命周期"));
    expect(body).toMatch(/titleAskedRef\.current\.has\(convKey\)/);
    expect(body).toMatch(/titleAskedRef\.current\.add\(convKey\)/);
    expect(body).toMatch(/cleanGeneratedTitle\(raw\)/);
    expect(body).toMatch(/displayTitle\(clean, conv\.parent !== null\)/);
    expect(body).toMatch(/setSessionTitle\(relDir, conv\.sessionFileId, label\)/);
    // 标题与对话共用会话自己的模型快照。
    expect(body).toMatch(/generateTitle\(seed, conv\.model \?\? undefined\)/);
  });

  it("恢复出来的 LLM 标题不会再生成一遍", () => {
    const fn = code.slice(code.indexOf("const launchRestored = useCallback"));
    const body = fn.slice(0, fn.indexOf("const restoreFamily"));
    expect(body).toMatch(/titleSource: sessionMeta\?\.titleSource === "llm" \? "llm" : "first-message"/);
  });
});
