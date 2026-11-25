import type { LayoutWarning, PaginationResult, SourceBlock } from "./types";
import type { TocEntry } from "./assemble";

export type VerifyStatus = "ok" | "missing" | "manual" | "mismatch";

export interface VerifyRow {
  id: string;
  /** 标题 / 正文 / 表格行 / 代码 / 图片 / 公式 */
  category: string;
  label: string;
  srcPath: string;
  srcLine: number;
  page?: number;
  status: VerifyStatus;
  note?: string;
}

export interface VerifyIssue {
  kind: "missing" | "blank-page" | "toc-page" | "clipped" | "wide-table" | "long-code" | "missing-image" | "link";
  detail: string;
  srcPath?: string;
  srcLine?: number;
  page?: number;
  /** 供并排对照：原始内容片段 */
  sourceText?: string;
  pdfText?: string;
}

export interface VerifyReport {
  pdfPath: string;
  pdfPages: number;
  layoutPages: number;
  rows: VerifyRow[];
  issues: VerifyIssue[];
  counts: { ok: number; missing: number; manual: number; mismatch: number };
  checkedAt: number;
  /** 是否发现必须修的问题 */
  failed: boolean;
}

export interface PdfDigest {
  pages: { text: string; images: number }[];
}

/**
 * 部首区字符（U+2E80–U+2FDF）一律当通配符。
 *
 * 为什么：Chromium 打 PDF 时，一部分字会用 Type3 字体按「部首形」画出来，
 * 写进 ToUnicode 的是部首码位。麻烦的是这个映射并不可信——实测「口」被写成了
 * U+2F1C（⼜），NFKC 之后变成「又」，于是「统计口径」在文字层里成了「统计又径」。
 * 既然码位不可信，就别猜它本来是什么字：把这一位当成「这里有一个字」，
 * 比对时该位置什么字都算对上。它在成品里占一个字符位，所以按长度对齐没问题。
 */
const WILD = "\u0001";

/**
 * 比对用的归一化。把「PDF 里真正画出来的东西」和「笔记原文」抹成同一种形态：
 *  - 部首区打成通配符（见上）；
 *  - NFKC：兼容字形、全角、（）等；
 *  - 去空白；
 *  - 去标点与符号：PDF 文本流里 `/`、`·`、`$` 这类符号常常换用别的字体，
 *    抽出来直接消失（实测表格里的「张启 / 李桦」会变成「张启  李桦」），
 *    留着它们只会制造假警报。汉字与数字不受影响，核对目标仍然是「内容在不在」。
 */
export const norm = (s: string) =>
  (s || "")
    .replace(/[\u2E80-\u2FDF]/g, WILD)
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}\s\u00a0\u3000\u200b-\u200d\ufeff]+/gu, "");

/** 带回退的包含查找：needle 里不会出现 WILD，hay 里的 WILD 匹配任意一个字符 */
export function findWild(hay: string, needle: string): number {
  if (!needle) return 0;
  const fast = hay.indexOf(needle);
  if (fast >= 0) return fast;
  if (!hay.includes(WILD)) return -1;
  const n = hay.length;
  const m = needle.length;
  for (let i = 0; i + m <= n; i++) {
    const h0 = hay.charCodeAt(i);
    if (h0 !== WILD.charCodeAt(0) && h0 !== needle.charCodeAt(0)) continue;
    let j = 1;
    while (j < m) {
      const h = hay[i + j];
      if (h !== needle[j] && h !== WILD) break;
      j++;
    }
    if (j === m) return i;
  }
  return -1;
}

const hasText = (hay: string, needle: string) => findWild(hay, needle) >= 0;

/** 源文本里「不会以文字形式出现在成品中」的部分先摘掉，否则必然误报 */
const plainSrc = (s: string) =>
  (s || "")
    // 行内/块级公式按图片渲染，源里的 LaTeX 不会出现在文字层
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$\n]+\$/g, " ")
    // 提示块的 [!warning] 标记
    .replace(/\[![^\]]*\]/g, " ")
    // 围栏行（```text 这种语言标记不是正文）
    .replace(/^[ \t]*```.*$/gm, " ")
    // 任务列表的 [x] / [ ]
    .replace(/^[ \t]*\[[ xX]\][ \t]*/gm, " ")
    // 块 id
    .replace(/\s\^[A-Za-z0-9-]+\s*$/gm, " ");

const head = (s: string, n: number) => s.slice(0, n);
const tail = (s: string, n: number) => s.slice(Math.max(0, s.length - n));

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n++;
    i = hay.indexOf(needle, i + 1);
  }
  return n;
}

export type Hit = "full" | "part" | "head" | "none";

/**
 * 判断一段文字在成品里到什么程度。
 * 整段命中 → full；只有开头命中 → head（大概率被截断）；
 * 分块覆盖率 ≥82% → full（允许跨页处被页眉页脚切开几个块）；
 * 35%~82% → part（缺了一截）。
 */
export function probe(needle: string, hay: string): Hit {
  if (!needle) return "full";
  if (hasText(hay, needle)) return "full";

  let total = 0;
  let hit = 0;
  for (let i = 0; i < needle.length; i += 4) {
    const chunk = needle.slice(i, i + 8);
    if (chunk.length < 4) break;
    total++;
    if (hasText(hay, chunk)) hit++;
  }
  const cov = total ? hit / total : 0;
  if (cov >= 0.82) return "full";

  const h = head(needle, Math.min(16, Math.ceil(needle.length / 2)));
  const hasHead = h.length >= 4 && hasText(hay, h);
  if (hasHead) return cov >= 0.3 ? "part" : "head";
  return cov >= 0.3 ? "part" : "none";
}

/** 表格行：开头与结尾都要在。跨页被表头切开时两头仍然各自存在，所以两头查得通 */
function rowPresent(cells: string[], docText: string): boolean {
  const joined = norm(cells.join(""));
  if (!joined) return true;
  const h = head(joined, 16);
  if (!hasText(docText, h)) return false;
  if (joined.length > 24) {
    const t = tail(joined, 10);
    if (!hasText(docText, t)) return false;
  }
  return true;
}

/** 把一段块文本按行切开，逐条核对用的条目 */
function itemsOf(text: string): string[] {
  return text
    .split(/\n+/)
    .map((x) => norm(plainSrc(x)))
    .filter((x) => x.length >= 4);
}

const CATEGORY: Record<string, string> = {
  heading: "标题",
  para: "正文",
  list: "列表",
  table: "表格",
  code: "代码",
  image: "图片",
  quote: "引用",
  callout: "提示块",
  math: "公式",
  mermaid: "图表",
  hr: "分隔线",
  unknown: "其他",
};

/**
 * 核对：把「应该进成品的内容」和「PDF 里实际有的文字」逐项比对。
 * 纯本地、确定性，不需要 AI。
 */
export function verify(
  pdf: PdfDigest,
  sources: SourceBlock[],
  layout: PaginationResult,
  opts: {
    pdfPath: string;
    toc?: { entry: TocEntry; text: string }[];
    tocPages?: number[];
    warnings?: LayoutWarning[];
    includeIds?: Set<string>;
  }
): VerifyReport {
  const pageText = pdf.pages.map((p) => norm(p.text));
  const docText = pageText.join("\n");
  const rows: VerifyRow[] = [];
  const issues: VerifyIssue[] = [];

  const pageOf = new Map<string, number>();
  for (const p of layout.placed) {
    if (!pageOf.has(p.id) || (p.page < (pageOf.get(p.id) ?? 1e9) && p.part === 1)) pageOf.set(p.id, p.page);
  }

  for (const src of sources) {
    if (!src.mustAppear) continue;
    if (opts.includeIds && !opts.includeIds.has(src.id)) continue;
    const category = CATEGORY[src.kind] ?? "其他";
    const page = pageOf.get(src.id);

    if (src.kind === "image" || src.kind === "math" || src.kind === "mermaid") {
      // 这三类没法靠文字确认，交给页面图像数/区块存在性判断
      const pagesWithImg = pdf.pages.filter((p) => p.images > 0).length;
      rows.push({
        id: src.id,
        category,
        label: src.text.slice(0, 40) || src.srcRaw || category,
        srcPath: src.srcPath,
        srcLine: src.srcLine,
        page,
        status: "manual",
        note:
          src.kind === "image"
            ? pagesWithImg > 0
              ? `成品里有 ${pagesWithImg} 页含图片，但无法自动确认是哪一张`
              : "成品未检出任何图片"
            : "公式与图表按图片渲染，需人工看一眼",
      });
      if (src.kind === "image" && pagesWithImg === 0) {
        issues.push({
          kind: "missing-image",
          detail: `图片未出现在成品中：${src.srcRaw ?? src.text}`,
          srcPath: src.srcPath,
          srcLine: src.srcLine,
          page,
          sourceText: src.srcRaw,
        });
      }
      continue;
    }

    // ---- 表格：逐行 ----
    if (src.kind === "table" && src.rows && src.rows.length > 1) {
      const missing: string[] = [];
      src.rows.forEach((cells, ri) => {
        if (!rowPresent(cells, docText)) missing.push(`第 ${ri + 1} 行：${cells.join(" | ").slice(0, 70)}`);
      });
      if (missing.length === 0) {
        rows.push({
          id: src.id,
          category,
          label: `表格 ${src.rows.length} 行`,
          srcPath: src.srcPath,
          srcLine: src.srcLine,
          page,
          status: "ok",
          note: `${src.rows.length} 行全部检出`,
        });
      } else {
        rows.push({
          id: src.id,
          category,
          label: `表格 ${src.rows.length} 行`,
          srcPath: src.srcPath,
          srcLine: src.srcLine,
          page,
          status: "missing",
          note: `缺 ${missing.length} 行`,
        });
        issues.push({
          kind: "missing",
          detail: `表格缺 ${missing.length} 行：${missing.slice(0, 4).join("；")}`,
          srcPath: src.srcPath,
          srcLine: src.srcLine,
          page,
          sourceText: missing.join("\n"),
          pdfText: page != null ? (pdf.pages[page - 1]?.text ?? "").slice(0, 400) : undefined,
        });
      }
      continue;
    }

    const n = norm(plainSrc(src.text));
    // 标题短到两三个字很常见（「采集层」），按块比对仍然可靠；
    // 正文类短到 4 字以下就没法检索了，交给人工
    const minLen = src.kind === "heading" ? 2 : 4;
    if (n.length < minLen) {
      rows.push({
        id: src.id,
        category,
        label: src.text || "(空)",
        srcPath: src.srcPath,
        srcLine: src.srcLine,
        page,
        status: "manual",
        note: "内容过短，无法可靠检索",
      });
      continue;
    }

    // ---- 列表 / 代码 / 提示块 / 引用：逐条 ----
    // 这几种都是「一坨里有很多条」的结构：整块比对时，跨页处被表头或页眉切开、
    // 或者中间夹一张图（公式），都会连带整块判成缺失。逐条比对才不会冤枉。
    if (src.kind === "list" || src.kind === "code" || src.kind === "callout" || src.kind === "quote") {
      const items = itemsOf(src.text);
      const unit = src.kind === "code" ? "行" : "条";
      if (items.length > 1) {
        const miss = items.filter((it) => {
          const h = probe(it, docText);
          return h === "none" || h === "head";
        });
        if (miss.length === 0) {
          rows.push({
            id: src.id,
            category,
            label: `${category} ${items.length} ${unit}`,
            srcPath: src.srcPath,
            srcLine: src.srcLine,
            page,
            status: "ok",
            note: `${items.length} ${unit}全部检出`,
          });
        } else {
          rows.push({
            id: src.id,
            category,
            label: `${category} ${items.length} ${unit}`,
            srcPath: src.srcPath,
            srcLine: src.srcLine,
            page,
            status: "missing",
            note: `缺 ${miss.length} ${unit}`,
          });
          issues.push({
            kind: "missing",
            detail: `${category}里少了 ${miss.length} ${unit}：${miss
              .slice(0, 3)
              .map((x) => x.slice(0, 40))
              .join("；")}`,
            srcPath: src.srcPath,
            srcLine: src.srcLine,
            page,
            sourceText: miss.join("\n").slice(0, 400),
            pdfText: page != null ? (pdf.pages[page - 1]?.text ?? "").slice(0, 400) : undefined,
          });
        }
        continue;
      }
    }

    // ---- 其余：整块 ----
    const hit = probe(n, docText);
    if (hit === "full") {
      rows.push({
        id: src.id,
        category,
        label: clip(src.text),
        srcPath: src.srcPath,
        srcLine: src.srcLine,
        page,
        status: "ok",
      });
      continue;
    }

    const note = hit === "part" ? "只检出部分内容（跨页或结尾被截断）" : "成品中未检出";
    rows.push({
      id: src.id,
      category,
      label: clip(src.text),
      srcPath: src.srcPath,
      srcLine: src.srcLine,
      page,
      status: "missing",
      note,
    });
    issues.push({
      kind: "missing",
      detail: `${hit === "part" ? "内容不完整" : "成品中找不到这一段"}：${clip(src.text)}`,
      srcPath: src.srcPath,
      srcLine: src.srcLine,
      page,
      sourceText: src.text.slice(0, 400),
      pdfText: page != null ? (pdf.pages[page - 1]?.text ?? "").slice(0, 400) : undefined,
    });
  }

  // 目录页码
  //
  // 两个坑：一是同一节名会在多篇笔记里重复出现（「延伸阅读」「复习卡」），
  // 用 indexOf 永远命中第一条，只能顺着目录往下扫，一条对一条；
  // 二是页码后面紧跟着下一条的标题，而标题可能以数字开头（「01 数列的概念」），
  // 直接取数字会把两条粘成「101」。所以按行取行尾数字。
  if (opts.toc?.length && opts.tocPages?.length) {
    const tocLines: string[] = [];
    for (const p of opts.tocPages) {
      for (const raw of (pdf.pages[p - 1]?.text ?? "").split("\n")) {
        const t = norm(raw);
        if (t) tocLines.push(t);
      }
    }
    let cursor = 0;
    for (const { entry } of opts.toc) {
      const t = norm(entry.text);
      if (t.length < 3) continue;
      const printed = entry.page;
      let at = -1;
      for (let i = cursor; i < tocLines.length; i++) {
        if (findWild(tocLines[i], t) >= 0) {
          at = i;
          break;
        }
      }
      // 目录里顺序错乱（或某条被拆行）时退回全表找一次，别把后面的条目全带偏
      if (at < 0) {
        for (let i = 0; i < tocLines.length; i++) {
          if (findWild(tocLines[i], t) >= 0) {
            at = i;
            break;
          }
        }
      }
      if (at < 0) {
        rows.push({
          id: `toc#${entry.text}`,
          category: "目录",
          label: entry.text,
          srcPath: "",
          srcLine: 0,
          status: "missing",
          note: "目录里找不到这一条",
        });
        issues.push({
          kind: "toc-page",
          detail: `目录缺条目：${entry.text}`,
          sourceText: entry.text,
        });
        continue;
      }
      cursor = at;
      const num = /(\d{1,4})$/.exec(tocLines[at])?.[1];
      if (!num) {
        rows.push({
          id: `toc#${entry.text}`,
          category: "目录",
          label: entry.text,
          srcPath: "",
          srcLine: 0,
          page: printed,
          status: "manual",
          note: "页码未能解析（可能被拆行）",
        });
      } else {
        const ok = String(num) === String(printed);
        rows.push({
          id: `toc#${entry.text}`,
          category: "目录",
          label: entry.text,
          srcPath: "",
          srcLine: 0,
          page: printed,
          status: ok ? "ok" : "mismatch",
          note: ok ? `页码 ${printed}` : `目录写 ${num}，实际 ${printed}`,
        });
        if (!ok) {
          issues.push({
            kind: "toc-page",
            detail: `目录页码不符：「${entry.text}」写 ${num}，实际 ${printed}`,
            page: printed,
            sourceText: entry.text,
          });
        }
      }
    }
  }

  // 空白页
  pdf.pages.forEach((p, i) => {
    if (!norm(p.text) && p.images === 0) {
      issues.push({ kind: "blank-page", detail: `第 ${i + 1} 页是空白页`, page: i + 1 });
    }
  });

  // 排版告警
  for (const w of opts.warnings ?? layout.warnings) {
    const kind =
      w.kind === "unsplittable" || w.kind === "clipped"
        ? ("clipped" as const)
        : w.kind === "empty-page"
          ? ("blank-page" as const)
          : (w.kind as "wide-table" | "long-code" | "missing-image");
    issues.push({
      kind,
      detail: w.detail,
      srcPath: w.srcPath,
      srcLine: w.srcLine,
      page: w.page,
    });
  }

  const counts = { ok: 0, missing: 0, manual: 0, mismatch: 0 };
  for (const r of rows) counts[r.status]++;

  const failed =
    counts.missing > 0 ||
    counts.mismatch > 0 ||
    pdf.pages.length !== layout.pages.length ||
    issues.some((i) => i.kind === "blank-page" || i.kind === "missing-image");

  return {
    pdfPath: opts.pdfPath,
    pdfPages: pdf.pages.length,
    layoutPages: layout.pages.length,
    rows,
    issues,
    counts,
    checkedAt: Date.now(),
    failed,
  };
}

function clip(s: string, n = 46): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

export { countOccurrences };
