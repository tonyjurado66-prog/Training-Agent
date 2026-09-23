// Markdown minimal et sûr : tout le HTML est échappé avant transformation.

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function renderInline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

export function renderMarkdown(md) {
  const lines = esc(md).split("\n");
  const out = [];
  let list = null; // "ul" | "ol"
  let para = [];
  let code = null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${renderInline(para.join("<br>"))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const line of lines) {
    if (code !== null) {
      if (line.trim().startsWith("```")) {
        out.push(`<pre><code>${code.join("\n")}</code></pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (line.trim().startsWith("```")) {
      flushPara(); closeList(); code = [];
      continue;
    }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (h) {
      flushPara(); closeList();
      out.push(`<p class="h">${renderInline(h[1])}</p>`);
    } else if (ul || ol) {
      flushPara();
      const kind = ul ? "ul" : "ol";
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${renderInline((ul || ol)[1])}</li>`);
    } else if (!line.trim()) {
      flushPara(); closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  if (code !== null) out.push(`<pre><code>${code.join("\n")}</code></pre>`);
  flushPara(); closeList();
  return out.join("");
}
