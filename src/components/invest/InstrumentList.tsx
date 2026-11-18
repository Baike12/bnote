import { useRef } from "react";

/** H6: the list mixes three currencies side by side — the price carries the
 * sign inline (¥ / HK$ / US$) instead of sending the user to the detail tab. */
const SIGN: Record<string, string> = { cn: "¥", hk: "HK$", us: "US$" };
import { useInvestStore } from "@/invest/store";
import { filterInstruments, scopeFor } from "@/invest/layoutModel";

/**
 * The left column: the instrument / sector list. One list component serves
 * both views — the scope kind only changes which rows are shown. A row click
 * is the explicit "make this the current scope" action; the store handles
 * the single-writer dance.
 *
 * Keyboard (C15/C16, the same-hexin convention): bare ↑/↓ walk the *filtered*
 * rows (the command layer routes them here through the invest region), Enter
 * opens the scope's document, and typing any character — the "keyboard
 * sprite" — jumps into the search box with that character appended, so a
 * code like 600519 lands on the instrument without touching the mouse.
 */

export function InstrumentList() {
  const viewKind = useInvestStore((s) => s.viewKind);
  const instruments = useInvestStore((s) => s.instruments);
  const sectors = useInvestStore((s) => s.sectors);
  const selectedScope = useInvestStore((s) => s.selectedScope);
  const query = useInvestStore((s) => s.query);
  const setQuery = useInvestStore((s) => s.setQuery);
  const appendQuery = useInvestStore((s) => s.appendQuery);
  const selectScope = useInvestStore((s) => s.selectScope);
  const toggleWatch = useInvestStore((s) => s.toggleWatch);
  const moveListCursor = useInvestStore((s) => s.moveListCursor);
  const quoteByCode = useInvestStore((s) => s.quoteByCode);
  const searchRef = useRef<HTMLInputElement>(null);

  // The keyboard sprite: any printable character typed while the list holds
  // the focus lands in the search box (the command layer does not dispatch
  // bare letters, so this only fires for real typing).
  const onSpriteKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length !== 1) return;
    const target = e.target as HTMLElement;
    // The search box already owns typing.
    if (target instanceof HTMLInputElement) return;
    searchRef.current?.focus();
    appendQuery(e.key);
    e.preventDefault();
  };

  if (viewKind === "sectors") {
    return (
      <div className="invest-list" data-key-region="invest" onKeyDown={onSpriteKey}>
        <div className="invest-list-search">
          <input
            ref={searchRef}
            value={query}
            placeholder="搜索板块名称"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                void moveListCursor(1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                void moveListCursor(-1);
              } else if (e.key === "Enter") {
                e.preventDefault();
                const top = sectors.find((s2) => s2.name.includes(query.trim()));
                if (top) void selectScope(scopeFor("sector", top.code), top.name);
              }
            }}
          />
        </div>
        <div className="invest-list-rows">
          {sectors
            .filter((s) => s.name.includes(query.trim()))
            .map((s) => (
              <button
                key={s.code}
                className={`invest-list-row${selectedScope === scopeFor("sector", s.code) ? " active" : ""}`}
                onClick={() => void selectScope(scopeFor("sector", s.code), s.name)}
              >
                <span className="invest-row-name">{s.name}</span>
                <span className="invest-row-code">{s.code}</span>
              </button>
            ))}
          {sectors.length === 0 && (
            <div className="invest-list-empty">板块骨架未加载（需要已打开仓库）。</div>
          )}
        </div>
      </div>
    );
  }

  const filtered = filterInstruments(instruments, query);
  // E23: the watchlist reads first (the walk order in moveListCursor matches).
  const watched = filtered.filter((i) => i.watch);
  const rest = filtered.filter((i) => !i.watch);
  const row = (i: (typeof filtered)[number]) => {
    const quote = quoteByCode[i.code];
    const change =
      quote?.prev_close && quote.prev_close > 0
        ? (quote.price - quote.prev_close) / quote.prev_close
        : null;
    return (
      <div
        key={i.code}
        className={`invest-list-row${selectedScope === scopeFor("stock", i.code) ? " active" : ""}`}
      >
        <button
          className="invest-row-main"
          onClick={() => void selectScope(scopeFor("stock", i.code), i.name)}
        >
          <span className="invest-row-name">{i.name}</span>
          <span className="invest-row-code">{i.code}</span>
          {i.market !== "cn" ? (
            <span className={`invest-row-market market-${i.market}`}>
              {i.market === "hk" ? "港" : "美"}
            </span>
          ) : null}
          {i.industry ? <span className="invest-row-industry">{i.industry}</span> : null}
        </button>
        <span className={`invest-row-quote${change == null ? "" : change >= 0 ? " up" : " down"}`}>
          {quote ? `${SIGN[i.market] ?? ""}${quote.price.toFixed(2)}` : "—"}
          <em>{change == null ? "" : `${change >= 0 ? "+" : ""}${(change * 100).toFixed(2)}%`}</em>
        </span>
        <button
          className={`invest-row-watch${i.watch ? " on" : ""}`}
          title={i.watch ? "移出自选" : "加入自选"}
          onClick={() => void toggleWatch(i.code)}
        >
          {i.watch ? "★" : "☆"}
        </button>
      </div>
    );
  };
  return (
    <div className="invest-list" data-key-region="invest" onKeyDown={onSpriteKey}>
      <div className="invest-list-search">
        <input
          ref={searchRef}
          value={query}
          placeholder="搜索代码或名称"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              void moveListCursor(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              void moveListCursor(-1);
            } else if (e.key === "Enter") {
              // H6 blind test: typing a code filtered the list but left the
              // selection on the previous instrument — Enter takes the top
              // match of the current filter.
              e.preventDefault();
              const top = filtered[0];
              if (top) void selectScope(scopeFor("stock", top.code), top.name);
            }
          }}
        />
      </div>
      <div className="invest-list-rows">
        {filtered.length > 0 && watched.length > 0 ? (
          <div className="invest-list-section">自选</div>
        ) : null}
        {watched.map(row)}
        {filtered.length > 0 && rest.length > 0 && watched.length > 0 ? (
          <div className="invest-list-section">全部</div>
        ) : null}
        {rest.map(row)}
        {filtered.length === 0 && (
          <div className="invest-list-empty">
            {query.trim()
              ? "无匹配标的。"
              : "本地标的库为空。导入 akshare 导出的 JSON 建立标的清单："}
            {!query.trim() ? (
              <button
                className="invest-import-empty-btn"
                onClick={() => useInvestStore.getState().openImport()}
              >
                导入数据
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
