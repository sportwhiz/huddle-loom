import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
const escape = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
// The source is trusted repository prose. Escape before adding the small set of
// supported formatting tags; no raw Markdown HTML is accepted.
const source = readFileSync("../../docs/security-operations.md", "utf8");
let code = false;
const body = source
  .split("\n")
  .map((line) => {
    if (line.startsWith("```")) {
      code = !code;
      return code ? "<pre><code>" : "</code></pre>";
    }
    if (code) return escape(line) + "\n";
    const escaped = escape(line)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
    if (line.startsWith("# ")) return `<h1>${escaped.slice(2)}</h1>`;
    if (line.startsWith("## ")) return `<h2>${escaped.slice(3)}</h2>`;
    return line ? `<p>${escaped}</p>` : "";
  })
  .join("\n");
mkdirSync("public/docs", { recursive: true });
writeFileSync(
  "public/docs/security-operations.html",
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Operate Huddle Loom</title><style>:root{color-scheme:light dark;font:16px/1.7 system-ui,sans-serif}body{margin:0;background:light-dark(#f7f8fc,#151923);color:light-dark(#253044,#e9edf5)}nav{padding:18px 5vw;border-bottom:1px solid light-dark(#dfe3ec,#343c4c)}nav a{float:right}main{max-width:850px;margin:40px auto;padding:0 24px 70px}h1{font-size:34px;line-height:1.2;letter-spacing:-1px}h2{margin-top:44px;font-size:23px;line-height:1.3}a{color:light-dark(#4262d6,#a2b1ff)}p{overflow-wrap:anywhere}code{font-size:.84em;background:light-dark(#e8edf8,#252e40);border-radius:4px;padding:2px 4px}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:18px;background:light-dark(#e8edf8,#252e40);border-radius:12px}pre code{padding:0}</style></head><body><nav><strong>Huddle Loom · Operator guide</strong><a href="/settings/system">Administration</a></nav><main>${body}</main></body></html>`,
);
