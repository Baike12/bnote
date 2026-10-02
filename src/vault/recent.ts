/**
 * 最近仓库的 MRU 模型(参考 zed 的 recent projects,要点两收:身份键去重、
 * 当前项在读取时过滤)。身份键就是后端 set_vault canonicalize 之后的路径
 * 字符串——文件夹选择器、启动恢复、本模块的切换拿到的都是同一份规范化
 * 产物,不需要第二套归一化。
 */

/** 硬上限:config.json 是单个 JSON,超出就丢最旧的(zed 无上限、靠 GC;这里列表小,cap 足够)。 */
export const RECENT_VAULTS_CAP = 10;

/** 打开/切换到某个仓库:提到队首,同路径去重,超出上限丢尾部。纯函数,不改入参。 */
export function touchRecentVault(list: string[], path: string): string[] {
  if (!path) return list.slice();
  return [path, ...list.filter((p) => p !== path)].slice(0, RECENT_VAULTS_CAP);
}

/**
 * 切换目标:MRU 里第一个非当前仓的路径。当前仓不写入时剔除而是读取时过滤
 * (zed 同款),列表里始终保留它——两仓来回 toggle 才成立。空列表、或只有
 * 当前仓时返回 null;未开仓(current 为 null)时返回最近一个,从欢迎页一键
 * 回到上次仓库。
 */
export function recentVaultTarget(list: string[], current: string | null): string | null {
  return list.find((p) => p !== current && p !== "") ?? null;
}
