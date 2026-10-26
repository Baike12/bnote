import { agentApi, type MaterialInfo, type StudyContent } from "@/lib/tauri";
import { vaultDotPath } from "./vaultJson";

/**
 * 学习材料的落盘目录(`<vault>/.bnote/materials/<kind>/<dir>/`)。
 *
 * 目录名由后端用 `pinyin_pro` 生成并登记在 `.bnote/materials/index.json`,
 * 同一份材料永远落到同一个目录——标题后补、改名都不会把批注/会话分叉到
 * 两个地方。前端只缓存「材料身份 → 目录」的解析结果,不自己拼名字。
 *
 * 身份:PDF 用绝对路径(后端会转成仓库相对路径),网页/微信读书用网址。
 */
const inflight = new Map<string, Promise<MaterialInfo | null>>();

/** 材料身份(与后端 `identity()` 的规则一致):网址忽略末尾斜杠。 */
export function studyIdentity(content: StudyContent): string {
  return content.kind === "pdf"
    ? `pdf:${content.path}`
    : `url:${content.url.replace(/\/+$/, "")}`;
}

export function materialCacheKey(vaultRoot: string, content: StudyContent): string {
  return `${vaultRoot}\u0000${studyIdentity(content)}`;
}

/**
 * 解析/创建材料目录。失败(浏览器 harness、无 vault、后端旧版)返回 null,
 * 调用方回退到「不落盘」的旧行为。
 */
export function ensureMaterial(
  vaultRoot: string,
  content: StudyContent,
): Promise<MaterialInfo | null> {
  const key = materialCacheKey(vaultRoot, content);
  const hit = inflight.get(key);
  if (hit) return hit;
  const pending = agentApi.materialEnsure(content).catch(() => null);
  inflight.set(key, pending);
  // 失败不缓存永久结果:下次打开还有机会建目录。
  void pending.then((info) => {
    if (!info && inflight.get(key) === pending) inflight.delete(key);
  });
  return pending;
}

/** 材料目录的绝对路径(`<vault>/.bnote/<relDir>`)。 */
export function materialAbsDir(vaultRoot: string, relDir: string): string {
  return vaultDotPath(vaultRoot, relDir);
}

/** 一份会话记录的绝对路径。 */
export function sessionFilePath(vaultRoot: string, relDir: string, id: string): string {
  return `${materialAbsDir(vaultRoot, relDir)}/sessions/${id}.jsonl`;
}

/** 测试用:清空缓存。 */
export function resetMaterialCache(): void {
  inflight.clear();
}
