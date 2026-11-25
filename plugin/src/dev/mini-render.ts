import type { MdBlock } from "../core/markdown";

/**
 * 测试台用的最小 markdown 渲染器。
 * 插件里用的是 Obsidian 自己的 MarkdownRenderer（双链、Callout、公式、Mermaid 都由它处理），
 * 这里只为了在没有 Obsidian 的环境里把同一套排版逻辑跑起来。
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(src: string): string {
  let s = esc(src);
  // 行内公式先占位，避免被后面的规则改写
  const maths: string[] = [];
  s = s.replace(/\$([^$\n]+)\$/g, (_, m: string) => {
    maths.push(m);
    return `\u0000${maths.length - 1}\u0000`;
  });
  s = s.replace(/!\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, (_, t: string) => `<span class="internal-link">${t}</span>`);
  s = s.replace(/\[\[([^\]|]+)(\|([^\]]*))?\]\]/g, (_, t: string, _p: string, a?: string) => `<span class="internal-link">${a || t}</span>`);
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, a: string, u: string) => `<img src="${u}" alt="${a}">`);
  s = s.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_, a: string, u: string) => `<a class="external-link" href="${u}">${a}</a>`);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/==([^=]+)==/g, "<mark>$1</mark>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<span class="math math-inline">${esc(maths[Number(i)])}</span>`);
  return s;
}

function cap(html: string, cls = "callout"): HTMLElement {
  const d = document.createElement("div");
  d.className = cls;
  d.innerHTML = html;
  return d;
}

export function renderBlock(b: MdBlock): HTMLElement {
  switch (b.kind) {
    case "heading": {
      const h = document.createElement(`h${Math.min(6, Math.max(1, b.level ?? 2))}`);
      h.innerHTML = inline(b.raw.replace(/^#{1,6}\s+/, ""));
      return h;
    }
    case "para": {
      const p = document.createElement("p");
      p.innerHTML = inline(b.raw.replace(/\n/g, " "));
      return p;
    }
    case "quote": {
      const q = document.createElement("blockquote");
      const body = b.raw.replace(/^\s*>\s?/gm, "");
      body.split(/\n{2,}/).forEach((chunk) => {
        if (!chunk.trim()) return;
        const p = document.createElement("p");
        p.innerHTML = inline(chunk.replace(/\n/g, " "));
        q.appendChild(p);
      });
      return q;
    }
    case "callout": {
      const m = /^\s*>\s*\[!(\w+)\]\s*(.*)$/m.exec(b.raw);
      const title = m?.[2]?.trim() || (m?.[1] ?? "note");
      const body = b.raw.replace(/^\s*>\s?\[![^\]]+\].*$/m, "").replace(/^\s*>\s?/gm, "");
      const d = cap("", "callout");
      const t = document.createElement("div");
      t.className = "callout-title";
      t.innerHTML = inline(title);
      const c = document.createElement("div");
      c.className = "callout-content";
      body.split(/\n{2,}/).forEach((chunk) => {
        if (!chunk.trim()) return;
        const p = document.createElement("p");
        p.innerHTML = inline(chunk.replace(/\n/g, " "));
        c.appendChild(p);
      });
      d.appendChild(t);
      d.appendChild(c);
      return d;
    }
    case "list":
      return renderList(b.raw);
    case "table": {
      const rows = b.rows ?? [];
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const trh = document.createElement("tr");
      (rows[0] ?? []).forEach((c) => {
        const th = document.createElement("th");
        th.innerHTML = inline(c);
        trh.appendChild(th);
      });
      thead.appendChild(trh);
      const tbody = document.createElement("tbody");
      rows.slice(1).forEach((r) => {
        const tr = document.createElement("tr");
        r.forEach((c) => {
          const td = document.createElement("td");
          td.innerHTML = inline(c);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(thead);
      table.appendChild(tbody);
      return table;
    }
    default: {
      const p = document.createElement("p");
      p.innerHTML = inline(b.raw);
      return p;
    }
  }
}

function renderList(raw: string): HTMLElement {
  const lines = raw.split("\n");
  const root = document.createElement("ul");
  const stack: { el: HTMLElement; indent: number }[] = [{ el: root, indent: -2 }];
  let ordered = false;

  for (const line of lines) {
    const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const isOl = /^\d/.test(m[2]);
    ordered = ordered || isOl;

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    let parent = stack[stack.length - 1].el;
    if (indent > stack[stack.length - 1].indent + 1 && parent.lastElementChild) {
      const sub = document.createElement(isOl ? "ol" : "ul");
      parent.lastElementChild.appendChild(sub);
      stack.push({ el: sub, indent });
      parent = sub;
    }

    const li = document.createElement("li");
    let text = m[3];
    if (/^\[[ xX]\]\s/.test(text)) {
      li.className = "task-list-item";
      const done = /^\[[xX]\]/.test(text);
      text = text.replace(/^\[[ xX]\]\s*/, "");
      li.innerHTML = `<input type="checkbox" class="task-list-item-checkbox" ${done ? "checked" : ""} disabled> ${inline(text)}`;
    } else {
      li.innerHTML = inline(text);
    }
    parent.appendChild(li);
  }
  if (ordered) root.tagName; // ol 用 ul 也能排，仅测试用
  return root;
}
