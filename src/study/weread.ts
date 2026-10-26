/**
 * 微信读书(weread.qq.com)作为学习模式网页内容的专属适配。
 *
 * 它在中栏还是那一条 `kind:"url"` 链路(见 commands/agent.rs 的原生子
 * webview),这里只提供两样东西:
 *
 *  1. **路由追踪**:微信读书是 SPA,从书架点开一本书只是 pushState,主窗口
 *     感知不到。运行时 hook history,进入 `/web/reader/` 路由后把
 *     `{url, title}` 写进 `document.title` 的 `bnote-weread:` 前缀——和批注
 *     的 `bnote-anno:` 走同一条 title 通道,Rust 按前缀分发成
 *     `study-weread-route` 事件,主窗口据此记录「最近读的书」。书名是异步
 *     渲染的,先以空书名上报(书籍立刻进历史),提取到后再补一次正确书名
 *     (按 url 去重,后来的正确书名覆盖)。
 *  2. **排版适配**(在 weread 实站逐条量过并验证过效果,2026-10):
 *     - 铺满:滚动模式的留白根因是 `.app_content` 的 `max-width:1000px` +
 *       正文 100px 边距;全部放开,正文只留 48px 呼吸边距。
 *     - 目录左停靠常驻:`.readerCatalog` 强制显示、停靠左侧 320px,遮罩
 *       (`wr_mask`,负责「点外部关闭」)隐藏,正文区右移让位——点章节跳转
 *       后目录也不收起,阅读时一直可见。
 *     - 护眼绿:与 PDF 护眼模式同一底色 `#dcebd6`(global.css 的
 *       `--pdf-gutter`),深色文字。全部规则挂在 `body.wr_page_reader`
 *       (阅读页才有的类)下,书架/商城不受影响。
 *     - 正文字色:可见字形是 canvas 按 weread 主题色画的防复制层(盖在
 *       DOM 文本上),CSS 字色只管得到 DOM 层;对 canvas 用
 *       `brightness(0)` 把字形压黑(透明度保留),才是绿底黑字。
 *     - 竖排/横排(双页)两种模式都适配(容器、字色、目录停靠各有差异,
 *       见 CSS 分组注释);weread 自己的悬浮工具栏与翻页条整体隐藏——
 *       目录已常驻,翻页走 PageUp/Down,代价是单双页/字号/主题的站内
 *       切换入口没了。竖排滚动仍是 bnote 集成最好的形态(批注按滚动
 *       语义工作),weread 在窄容器里也会自动选竖排;**不要**试图用
 *       合成事件替用户切模式——weread 的控件过滤非可信事件(实站验证,
 *       click/PointerEvent 全套都不理会)。
 *
 * 运行时挂在**通用初始化脚本**里(每次导航都会重装,SPA 站内跳书后依然
 * 生效),开头按 hostname 自门控:非微信读书的页面一行都不执行。
 */

/** 微信读书站点与书架入口。 */
export const WEREAD_HOST = "weread.qq.com";
export const WEREAD_HOME_URL = `https://${WEREAD_HOST}/`;

/** title 通道前缀(Rust 侧 agent.rs 按它分发 study-weread-route 事件)。 */
export const WEREAD_TITLE_PREFIX = "bnote-weread:";

const READER_PATH = "/web/reader/";

export function isWereadUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === WEREAD_HOST || host === `www.${WEREAD_HOST}`;
  } catch {
    return false;
  }
}

/** 只有真正打开书的阅读器路由才记历史;书架/商城/详情页不算。 */
export function isWereadReaderUrl(url: string): boolean {
  if (!isWereadUrl(url)) return false;
  try {
    return new URL(url).pathname.startsWith(READER_PATH);
  } catch {
    return false;
  }
}

/** 书名还没提取到时的兜底显示(去掉路由前缀取书哈希的一段)。 */
export function wereadFallbackTitle(url: string): string {
  try {
    const tail = new URL(url).pathname.slice(READER_PATH.length).trim();
    return tail ? `微信读书 ${tail.slice(0, 12)}` : "微信读书";
  } catch {
    return "微信读书";
  }
}

export interface WereadRoutePayload {
  url: string;
  title: string;
}

/**
 * 校验 study-weread-route 事件的负载。Rust 只做了「前缀匹配 + JSON 解析」,
 * 字段形状由这里把关:坏数据一律 null,绝不把垃圾写进历史。
 */
export function normalizeWereadRoute(value: unknown): WereadRoutePayload | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<WereadRoutePayload>;
  if (typeof raw.url !== "string" || !isWereadReaderUrl(raw.url)) return null;
  if (typeof raw.title !== "string") return null;
  return { url: raw.url, title: raw.title };
}

// ---------------------------------------------------------------------------
// 注入页面的运行时
// ---------------------------------------------------------------------------

/**
 * 自包含:整个函数会被 `toString()` 序列化进页面(见 buildWereadScript),
 * 不能引用任何模块级变量,常量经 args 传入。微信读书之外的网站在第一行
 * 就返回,零开销。
 *
 * 选择器与色值都是在 weread 实站上量出来的(见文件头);weread 改版时的
 * 症状:留白回来 / 目录回右侧 / 主题回它自己的配色——按类名核对即可。
 */
function wereadRuntime(args: {
  marker: string;
  readerPath: string;
  styleId: string;
}): void {
  if (location.hostname !== "weread.qq.com" && location.hostname !== "www.weread.qq.com") {
    return;
  }

  const isReader = () => location.pathname.startsWith(args.readerPath);
  const routeUrl = () => location.origin + location.pathname;

  // ---- 排版适配 CSS(实站验证过;依据与分组见文件头)----
  const ensureStyle = () => {
    if (document.getElementById(args.styleId)) return;
    const style = document.createElement("style");
    style.id = args.styleId;
    style.textContent = [
      // 1. 宽度铺满:滚动模式的留白根因是 .app_content 的 max-width:1000px,
      //    横排模式是正文的 max-width:2096px;边距从 100px 收到 48px。
      "body.wr_page_reader .app_content { max-width: none !important; }",
      "body.wr_page_reader .readerChapterContent { max-width: none !important; }",
      "body.wr_page_reader .readerChapterContent { margin-left: 48px !important; margin-right: 48px !important; }",
      // 2. 目录左停靠常驻:面板原本 absolute right:0、靠 wr_mask 点外部关闭。
      //    强制显示 + 停左 + 隐遮罩 + 正文右移;点章节跳转后照样打开。
      "body.wr_page_reader .readerCatalog { display: block !important; left: 0 !important; right: auto !important; top: 72px !important; width: 320px !important; margin-left: 0 !important; transform: none !important; }",
      "body.wr_page_reader .wr_mask:has(~ .readerCatalog) { display: none !important; }",
      "body.wr_page_reader .readerContent, body.wr_page_reader .wr_horizontalReader_app_content { padding-left: 320px !important; }",
      // 3. 护眼绿 #dcebd6 = PDF 护眼模式的 --pdf-gutter,深色文字。
      "body.wr_page_reader { background: #dcebd6 !important; color: #33413a !important; }",
      "body.wr_page_reader .app_content, body.wr_page_reader .wr_horizontalReader_app_content { background: #dcebd6 !important; }",
      "body.wr_page_reader .readerTopBar { background: #dcebd6 !important; }",
      "body.wr_page_reader .readerTopBar, body.wr_page_reader .readerTopBar button { color: #33413a !important; }",
      "body.wr_page_reader .readerCatalog { background: #dcebd6 !important; }",
      "body.wr_page_reader .readerCatalog, body.wr_page_reader .readerCatalog * { color: #33413a !important; }",
      "body.wr_page_reader .readerChapterContent { color: #2f3a33 !important; }",
      "body.wr_page_reader .readerControls_item { background: #dcebd6 !important; color: #33413a !important; }",
      "body.wr_page_reader .readerFooter { background: #dcebd6 !important; }",
      "body.wr_page_reader .readerFooter_button { background: #cfe3c8 !important; color: #33413a !important; }",
      // 4. 可见的正文字形是 canvas 按 weread 主题色画的(防复制,盖在 DOM
      //    文本之上,z-index:2)——CSS 字色只改得到 DOM 层,所以绿底上还是
      //    主题的浅色字。canvas 底色透明、只画字形:brightness(0) 把不透明
      //    像素压成黑色、透明度保留,即黑字绿底,与 PDF 护眼一致。
      "body.wr_page_reader .wr_canvasContainer canvas { filter: brightness(0) !important; }",
      // 5. 横排(双页)模式:页面容器(.readerChapterContent/_container)自身
      //    带深色底,一并涂绿,否则切到双页后正文区还是黑的。
      "body.wr_page_reader .readerChapterContent, body.wr_page_reader .readerChapterContent_container { background: #dcebd6 !important; }",
      // 6. 字色通配到所有后代:横排下 weread 在内层页面类(如
      //    wr_flyleaf_page_*)上直接设浅色——祖先上的 !important 管不到
      //    直接规则;目录能变深就是靠同款通配。svg/canvas 排除(插图是
      //    <img> 不吃 color,svg 图标有自己的 fill)。
      "body.wr_page_reader .readerChapterContent, body.wr_page_reader .readerChapterContent *:not(svg):not(canvas) { color: #2f3a33 !important; }",
      // 7. 目录 fixed 停靠视口左缘:横排下它的定位祖先是 position:relative
      //    的正文容器,absolute + left:0 只能停到正文左缘(缩在中间)。
      "body.wr_page_reader .readerCatalog { position: fixed !important; bottom: 0 !important; }",
      // 8. 去掉侧边切换按钮:右侧悬浮工具栏(目录/笔记/单双页/字号/主题)
      //    与底部翻页条。目录已常驻左栏,翻页走 PageUp/Down 或点击页面。
      //    代价:weread 内部的单双页/字号/主题切换入口没了(两类模式都已
      //    适配,见上)。
      "body.wr_page_reader .readerControls { display: none !important; }",
      "body.wr_page_reader .renderTarget_pager { display: none !important; }",
    ].join("\n");
    (document.head || document.documentElement).appendChild(style);
  };

  // ---- 路由追踪:reader 路由 → title 通道 ----
  let reportedUrl = "";
  let reportedTitle = "";
  let titleRetries = 0;
  let titleTimer: ReturnType<typeof setTimeout> | undefined;

  const report = (title: string) => {
    const url = routeUrl();
    if (url === reportedUrl && title === reportedTitle) return;
    reportedUrl = url;
    reportedTitle = title;
    document.title = `${args.marker}${JSON.stringify({ url, title })}`;
  };

  // 书名在顶栏,异步渲染:每 500ms 看一眼,拿到就补报一次并停止。
  // DOM 选择器是 weread 实站的下划线风格类名;兜底解析 weread 自己设置的
  // document.title(「书名 - 作者 - 微信读书」)。注意别把我们自己写入的
  // marker 消息当成书名。
  const TITLE_SELECTORS = [
    ".readerTopBar_title_link",
    ".readerTopBar_title",
    "[class*='readerTopBar_title']",
  ];
  const readDomTitle = (): string => {
    for (const sel of TITLE_SELECTORS) {
      const el = document.querySelector(sel);
      const text = el && el.textContent ? el.textContent.trim() : "";
      if (text) return text;
    }
    const t = document.title;
    if (t && !t.startsWith(args.marker)) {
      const cleaned = t.replace(/\s*-\s*微信读书\s*$/, "").trim();
      const name = cleaned.split(/\s+-\s+/)[0].trim();
      if (name) return name;
    }
    return "";
  };
  const scheduleTitleRetry = () => {
    if (titleTimer !== undefined) clearTimeout(titleTimer);
    titleTimer = setTimeout(() => {
      titleTimer = undefined;
      if (!isReader() || reportedTitle) return;
      const title = readDomTitle();
      if (title) {
        report(title);
        return;
      }
      if (titleRetries++ < 20) scheduleTitleRetry();
    }, 500);
  };

  const onRoute = () => {
    ensureStyle();
    if (!isReader()) return;
    reportedTitle = "";
    titleRetries = 0;
    report("");
    scheduleTitleRetry();
  };

  // SPA 路由:hook pushState/replaceState,popstate 走事件。
  const wrapHistory = (key: "pushState" | "replaceState") => {
    const original = history[key].bind(history);
    history[key] = ((
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ) => {
      const result = original(data, unused, url);
      queueMicrotask(onRoute);
      return result;
    }) as typeof history.pushState;
  };
  wrapHistory("pushState");
  wrapHistory("replaceState");

  // document_start 时 head 可能还没就绪(样式先挂到 html 上),补一次。
  document.addEventListener("DOMContentLoaded", ensureStyle);
  window.addEventListener("popstate", onRoute);
  ensureStyle();
  onRoute();
}

/** 注入原生 webview 的微信读书运行时(自包含,常量内联)。 */
export function buildWereadScript(): string {
  return `(${wereadRuntime.toString()})(${JSON.stringify({
    marker: WEREAD_TITLE_PREFIX,
    readerPath: READER_PATH,
    styleId: "bnote-weread-style",
  })});`;
}

/** 只算一次:主窗口把它拼进 previewInitScript,交给 Rust 注册成初始化脚本。 */
export const WEREAD_SCRIPT = buildWereadScript();
