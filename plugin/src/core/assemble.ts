import type { BlockKind, DocSettings, SourceBlock } from "./types";
import type { Template } from "./templates";
import { firstHeading, parseMarkdown, type MdBlock } from "./markdown";
import { highlightLine } from "./highlight";

export interface DocItem {
  path: string;
  role: "chapter" | "section";
  title?: string;
  md: string;
}

export interface AssembleResult {
  blocks: HTMLElement[];
  sources: SourceBlock[];
  /** 章节标题与起页块 id，供目录使用 */
  chapters: { index: number; title: string; id: string }[];
}

export type BlockHtmlRenderer = (b: MdBlock, path: string) => HTMLElement;

const mk = <K extends keyof HTMLElementTagNameMap>(t: K, c?: string) => {
  const e = document.createElement(t);
  if (c) e.className = c;
  return e;
};

let counter = 0;
const newId = () => `b${(++counter).toString(36)}`;

export function slugId(path: string, line: number): string {
  return `${path}#L${line}`;
}

/**
 * 把若干笔记合成一份排版单元。
 * 每个块保留：源路径、源行号、可核对文本。
 */
export function assemble(
  items: DocItem[],
  settings: DocSettings,
  template: Template,
  renderBlock: BlockHtmlRenderer,
  excluded: Set<string> = new Set(),
  opts: { resolveImage?: (src: string, from: string) => string } = {}
): AssembleResult {
  const blocks: HTMLElement[] = [];
  const sources: SourceBlock[] = [];
  const chapters: AssembleResult["chapters"] = [];

  items.forEach((item, itemIndex) => {
    const md = item.md ?? "";
    const parsed = parseMarkdown(md);
    const chapterNo = itemIndex + 1;
    const ownTitle = item.title ?? firstHeading(md) ?? item.path;
    const isChapter = item.role === "chapter";

    // 章节首页
    if (isChapter || itemIndex === 0) {
      const head = mk("div", "ntb-chapter-head");
      // 大号码版式是 height:100% 的整页设计，只有「章首页独占一页」时成立。
      // 关掉独占却还留大号码，那一块就只能悬在半页处、顶出页底被裁掉。
      const fullPageHead = isChapter && settings.chapter.bigNumber && settings.chapter.ownPage;
      if (fullPageHead) {
        head.dataset.ntbPage = "chapter";
        head.classList.remove("sub");
      } else {
        head.dataset.ntbBreak = "page";
        head.dataset.ntbBreakAvoid = "1";
        head.classList.add("sub");
      }
      head.dataset.ntbKind = "chapter";
      head.dataset.ntbId = slugId(item.path, 0);
      head.dataset.ntbChapter = String(chapterNo);
      head.dataset.ntbChapterTitle = ownTitle;
      if (fullPageHead) {
        const num = mk("div", "num");
        num.textContent = String(chapterNo).padStart(2, "0");
        head.appendChild(num);
      }
      const ttl = mk("div", "ttl");
      ttl.textContent = ownTitle;
      head.appendChild(ttl);
      if (settings.chapter.rule) head.appendChild(mk("div", "rule"));
      blocks.push(head);
      chapters.push({ index: chapterNo, title: ownTitle, id: head.dataset.ntbId! });
      sources.push({
        id: head.dataset.ntbId!,
        kind: "heading",
        srcPath: item.path,
        srcLine: 1,
        text: ownTitle,
        level: 1,
        chapterIndex: chapterNo,
        chapterTitle: ownTitle,
        mustAppear: true,
      });
    }

    let consumedTitle = false;

    parsed.forEach((b) => {
      const id = slugId(item.path, b.startLine);
      if (excluded.has(id)) return;

      let kind: BlockKind = b.kind;
      // 章节名：第一项的第一条一级标题已经做过章首页，不再重复
      if (kind === "heading" && b.level === 1 && !consumedTitle && (isChapter || itemIndex === 0)) {
        consumedTitle = true;
        return;
      }
      // 单篇文档没有章首页时，一级标题照样是标题
      const el = buildBlock(b, kind, item.path, renderBlock, opts.resolveImage);
      if (!el) return;
      el.dataset.ntbKind = kind;
      el.dataset.ntbId = id;
      el.dataset.ntbChapter = String(chapterNo);
      el.dataset.ntbChapterTitle = ownTitle;

      if (kind === "heading") {
        el.dataset.ntbBreak = "avoid";
        // 二级标题在多数模板里另起页无关；一级标题（非章首）另起页
        if (b.level === 1 && settings.chapter.ownPage) el.dataset.ntbBreak = "page";
      }

      blocks.push(el);
      sources.push({
        id,
        kind,
        srcPath: item.path,
        srcLine: b.startLine,
        text: b.text,
        level: b.level,
        rows: b.rows,
        chapterIndex: chapterNo,
        chapterTitle: ownTitle,
        codeLines: kind === "code" ? b.text.split("\n").length : undefined,
        srcRaw: b.srcRaw,
        mustAppear: kind !== "hr" && kind !== "unknown" && b.text.trim().length > 0,
      });
    });
  });

  return { blocks, sources, chapters };
}

function buildBlock(
  b: MdBlock,
  kind: BlockKind,
  path: string,
  renderBlock: BlockHtmlRenderer,
  resolveImage?: (src: string, from: string) => string
): HTMLElement | null {
  if (kind === "hr") {
    const hr = mk("hr");
    return hr;
  }
  if (kind === "code") return buildCode(b);

  if (kind === "mermaid" || kind === "math") {
    // 交给渲染器（Obsidian 会画成 svg / 公式）；渲染不出来时退回可读源码
    const host = renderBlock(b, path);
    const rendered = kind === "mermaid" ? host.querySelector("svg") : host.querySelector("mjx-container, .MathJax, svg");
    const box = mk("div", kind === "mermaid" ? "ntb-mermaid" : "math-block");
    if (rendered) {
      box.appendChild(kind === "mermaid" ? (host.querySelector("svg") ?? host) : host);
      return box;
    }
    box.dataset.ntbFallback = "1";
    const pre = mk("pre", "ntb-raw-" + kind);
    pre.textContent = kind === "mermaid" ? b.raw : b.text;
    box.appendChild(pre);
    return box;
  }
  if (kind === "image") {
    return buildImage(b, path, resolveImage);
  }

  const html = renderBlock(b, path);
  if (kind === "table") {
    const wrap = mk("div", "ntb-table-wrap");
    const table = html.querySelector("table") ?? html;
    wrap.appendChild(table);
    return wrap;
  }
  if (kind === "para") {
    // 渲染器可能给出多个 <p>，统一成块容器
    if (html.children.length === 1 && html.firstElementChild?.tagName === "P") {
      return html.firstElementChild as HTMLElement;
    }
    const div = mk("div", "ntb-para-group");
    div.appendChild(html);
    return div;
  }
  return html;
}

function buildImage(b: MdBlock, from: string, resolve?: (src: string, from: string) => string): HTMLElement {
  const fig = mk("figure");
  const rawSrc = b.srcRaw ?? "";
  const src = resolve ? resolve(rawSrc, from) : rawSrc;
  const img = mk("img");
  img.src = src;
  img.alt = b.text;
  img.dataset.ntbSrc = rawSrc;
  const cap = mk("div", "ntb-figcap");
  const alt = b.text && b.text !== rawSrc ? b.text : "";
  cap.textContent = alt;
  fig.appendChild(img);
  if (alt) fig.appendChild(cap);
  img.addEventListener("error", () => {
    const miss = mk("div", "ntb-img-missing");
    miss.textContent = `图片缺失：${rawSrc}`;
    fig.replaceWith(miss);
  });
  return fig;
}

function buildCode(b: MdBlock): HTMLElement {
  const pre = mk("pre");
  pre.dataset.lang = b.srcRaw ?? "";
  const lines = b.text.split("\n");
  const startNo = 1;
  lines.forEach((ln, i) => {
    const row = mk("div", "ntb-code-line");
    const num = mk("span", "ntb-ln");
    num.textContent = String(startNo + i);
    const code = mk("span", "ntb-lc");
    code.innerHTML = highlightLine(ln, { lang: b.srcRaw });
    row.appendChild(num);
    row.appendChild(code);
    pre.appendChild(row);
  });
  return pre;
}

// ---------- 封面与目录 ----------

export function buildCover(s: DocSettings): HTMLElement {
  const cover = mk("div", "ntb-cover");
  cover.dataset.ntbPage = "cover";
  cover.dataset.ntbKind = "cover";
  cover.dataset.ntbId = "cover";
  cover.classList.add(s.cover.align);
  const t = mk("div", "ct");
  t.textContent = s.cover.title;
  cover.appendChild(t);
  if (s.cover.rule) cover.appendChild(mk("div", "cr"));
  if (s.cover.subtitle) {
    const st = mk("div", "cs");
    st.textContent = s.cover.subtitle;
    cover.appendChild(st);
  }
  if (s.cover.author) {
    const a = mk("div", "ca");
    a.textContent = s.cover.author;
    cover.appendChild(a);
  }
  if (s.cover.date) {
    const d = mk("div", "cd");
    d.textContent = s.cover.date;
    cover.appendChild(d);
  }
  return cover;
}

export interface TocEntry {
  text: string;
  level: number;
  page: number;
  chapterIndex: number;
}

export function buildToc(
  entries: TocEntry[],
  s: DocSettings
): { blocks: HTMLElement[]; source: SourceBlock } {
  const blocks: HTMLElement[] = [];
  const titleId = "toc#title";
  const title = mk("div", "ntb-toc-title");
  title.textContent = s.toc.title || "目录";
  title.dataset.ntbKind = "toc";
  title.dataset.ntbBreak = "page";
  title.dataset.ntbId = titleId;
  blocks.push(title);

  entries.forEach((e, i) => {
    const row = mk("div", `ntb-toc-row lv${Math.min(3, e.level)}`);
    row.dataset.ntbKind = "toc";
    row.dataset.ntbId = `toc#r${i}`;
    const tx = mk("span", "tx");
    tx.textContent = e.text;
    const dots = mk("span", "dots");
    const pg = mk("span", "pg");
    pg.textContent = String(e.page);
    row.append(tx, dots, pg);
    blocks.push(row);
  });

  return {
    blocks,
    source: {
      id: titleId,
      kind: "heading",
      srcPath: "",
      srcLine: 0,
      text: s.toc.title || "目录",
      level: 1,
      chapterIndex: 0,
      chapterTitle: "目录",
      mustAppear: true,
    },
  };
}
