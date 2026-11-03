/**
 * The document handed to an agent HTML preview iframe.
 *
 * The framed page may not read the parent (sandbox without allow-same-origin),
 * so it reports its own height back over postMessage; the token ties each
 * message to the one iframe that sent it, because several previews can be on
 * screen at once. The script is appended after the code verbatim: the parser
 * keeps executing a script placed after </html>.
 *
 * Pure string work, locked by htmlPreview.test.ts.
 */

/** Sentinel used by both sides of the height channel (HtmlPreview listens for it). */
export const PREVIEW_HEIGHT_FLAG = "__bnotePreview";

function heightScript(token: string): string {
  // JSON literal first, then escape `<` so a token can never close the inline
  // script element early (`</script>` inside a JSON string is still markup to
  // the HTML parser). Tokens are self-generated, this is defense in depth.
  const json = (value: string) => JSON.stringify(value).replace(/</g, "\\u003c");
  const flag = json(PREVIEW_HEIGHT_FLAG);
  return [
    "<script>(function(){",
    `var f=${flag},t=${json(token)};`,
    // Height = the larger of the two scrollHeights: html may collapse to the
    // viewport while body carries the content (and the reverse).
    "function send(){var h=Math.max(document.documentElement.scrollHeight,",
    "document.body?document.body.scrollHeight:0);",
    'parent.postMessage({[f]:t,height:h},"*")}',
    "function watch(){send();",
    "if(window.ResizeObserver){new ResizeObserver(send).observe(document.body)}",
    'window.addEventListener("load",send);setTimeout(send,300)}',
    'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",watch)}else{watch()}',
    "})();<\/script>",
  ].join("");
}

export function wrapPreviewDocument(code: string, token: string): string {
  return `${code}\n${heightScript(token)}`;
}
