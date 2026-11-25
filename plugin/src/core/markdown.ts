import type { BlockKind } from "./types";

export interface MdBlock {
  kind: BlockKind;
  startLine: number; // 1-based
  endLine: number;
  raw: string;
  level?: number;
  /** 用于核对的纯文本 */
  text: string;
  rows?: string[][];
  srcRaw?: string;
}

const FENCE = /^(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*([-*_])\s*(\1\s*){2,}$/;
const UL = /^(\s*)([-*+])\s+(.*)$/;
const OL = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;
const IMG_ONLY = /^\s*!\[\[([^\]]+)\]\]\s*$/;
const IMG_MD = /^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/;
const EMBED_ONLY = /^\s*!\[\[([^\]]+)\]\]\s*$/;
const CALLOUT = /^\s*>\s*\[!(\w+)\]/;
const MATH_FENCE = /^\s*\$\$\s*$/;

function cleanInline(s: string): string {
  return s
    .replace(/!\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, (_, t: string) => t)
    .replace(/\[\[([^\]|]+)(\|([^\]]*))?\]\]/g, (_, t: string, _p: string, a?: string) => a || t)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, a: string) => a || "图")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
}

export function stripFrontmatter(md: string): { body: string; offset: number } {
  const lines = md.split(/\r?\n/);
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        return { body: lines.slice(i + 1).join("\n"), offset: i + 1 };
      }
    }
  }
  return { body: md, offset: 0 };
}

/**
 * 把 markdown 切成顶层块，带源行号。
 * 只做「块边界」判断，不解析内联语法——内联交给渲染器（Obsidian 或测试台）。
 */
export function parseMarkdown(md: string): MdBlock[] {
  const { body, offset } = stripFrontmatter(md);
  const lines = body.split(/\r?\n/);
  const out: MdBlock[] = [];
  let i = 0;

  const push = (b: {
    kind: BlockKind;
    start: number;
    end: number;
    text: string;
    level?: number;
    rows?: string[][];
    srcRaw?: string;
  }) => {
    out.push({
      kind: b.kind,
      startLine: b.start + offset + 1,
      endLine: b.end + offset + 1,
      raw: lines.slice(b.start, b.end + 1).join("\n"),
      level: b.level,
      text: b.text,
      rows: b.rows,
      srcRaw: b.srcRaw,
    });
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // 代码块
    const fence = FENCE.exec(trimmed);
    if (fence) {
      const start = i;
      const lang = fence[2];
      i++;
      while (i < lines.length && !FENCE.test(lines[i].trim())) i++;
      const end = Math.min(i, lines.length - 1);
      const inner = lines.slice(start + 1, i).join("\n");
      push({
        kind: lang === "mermaid" ? "mermaid" : "code",
        start,
        end,
        text: inner,
        level: undefined,
        srcRaw: lang,
      });
      i = end + 1;
      continue;
    }

    // 公式块
    if (MATH_FENCE.test(trimmed)) {
      const start = i;
      i++;
      while (i < lines.length && !MATH_FENCE.test(lines[i].trim())) i++;
      push({ kind: "math", start, end: Math.min(i, lines.length - 1), text: lines.slice(start + 1, i).join("\n") });
      i++;
      continue;
    }

    // 标题
    const h = HEADING.exec(trimmed);
    if (h) {
      push({ kind: "heading", start: i, end: i, text: cleanInline(h[2]), level: h[1].length });
      i++;
      continue;
    }

    // 分隔线
    if (HR.test(trimmed)) {
      push({ kind: "hr", start: i, end: i, text: "" });
      i++;
      continue;
    }

    // 表格
    if (trimmed.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const start = i;
      const header = splitRow(lines[i]);
      i += 2;
      const rows: string[][] = [header.map(cleanInline)];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]).map(cleanInline));
        i++;
      }
      push({
        kind: "table",
        start,
        end: i - 1,
        text: rows.map((r) => r.join(" ")).join(" / "),
        rows,
      });
      continue;
    }

    // 图片 / 嵌入独占一行
    const img = IMG_ONLY.exec(line) || IMG_MD.exec(line);
    if (img) {
      const target = (IMG_MD.exec(line) ? img[2] : img[1]) ?? "";
      push({
        kind: EMBED_ONLY.test(line) && /\.(md|pdf)$/i.test(target) ? "unknown" : "image",
        start: i,
        end: i,
        text: cleanInline(line) || target,
        srcRaw: target,
      });
      i++;
      continue;
    }

    // 引用 / Callout
    if (trimmed.startsWith(">")) {
      const start = i;
      while (i < lines.length && (lines[i].trim().startsWith(">") || (lines[i].trim() && !/^(#{1,6}\s|\||```)/.test(lines[i].trim()) && lines[i - 1]?.trim().startsWith(">")))) {
        if (!lines[i].trim()) break;
        i++;
      }
      const raw = lines.slice(start, i).join("\n");
      push({
        kind: CALLOUT.test(trimmed) ? "callout" : "quote",
        start,
        end: i - 1,
        // 围栏行（```text 之类）只是语言标记，不参与核对；里面的代码内容要留着
        text: cleanInline(raw.replace(/^\s*>\s?/gm, "").replace(/^[ \t]*```.*$/gm, "")),
      });
      continue;
    }

    // 列表
    if (UL.test(line) || OL.test(line)) {
      const start = i;
      const baseIndent = (/^(\s*)/.exec(line)?.[1] ?? "").length;
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) {
          // 列表内的空行：看后面是否继续列表
          const nxt = lines[i + 1] ?? "";
          if (UL.test(nxt) || OL.test(nxt) || (/^\s{2,}\S/.test(nxt) && nxt.trim())) {
            i++;
            continue;
          }
          break;
        }
        const indent = (/^(\s*)/.exec(l)?.[1] ?? "").length;
        if (UL.test(l) || OL.test(l) || indent > baseIndent || /^\s{2,}\S/.test(l)) {
          i++;
          continue;
        }
        break;
      }
      const raw = lines.slice(start, i).join("\n");
      push({ kind: "list", start, end: i - 1, text: cleanInline(raw.replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")) });
      continue;
    }

    // 段落
    const start = i;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) break;
      if (i > start && (FENCE.test(l.trim()) || HEADING.test(l.trim()) || TABLE_SEP.test(l) || UL.test(l) || OL.test(l) || l.trim().startsWith(">"))) break;
      if (i > start && l.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) break;
      i++;
    }
    push({ kind: "para", start, end: i - 1, text: cleanInline(lines.slice(start, i).join(" ")) });
  }
  return out;
}

function splitRow(line: string): string[] {
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return s.split("|").map((c) => c.trim());
}

/** 从 markdown 里抽出一级标题，作为章节名 */
export function firstHeading(md: string): string {
  for (const b of parseMarkdown(md)) {
    if (b.kind === "heading" && b.level === 1) return b.text;
  }
  for (const b of parseMarkdown(md)) {
    if (b.kind === "heading") return b.text;
  }
  return "";
}
