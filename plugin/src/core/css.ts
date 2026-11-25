import type { DocSettings } from "./types";
import { PAPERS } from "./types";
import type { Template } from "./templates";

export const FONT_SONG =
  '"Songti SC","SimSun","Source Han Serif SC","Noto Serif CJK SC","Times New Roman",serif';
export const FONT_HEI =
  '"PingFang SC","Heiti SC","Microsoft YaHei","Source Han Sans SC","Noto Sans CJK SC",sans-serif';
export const FONT_MONO =
  '"SFMono-Regular",Menlo,Consolas,"DejaVu Sans Mono","Songti SC",monospace';

/** 页面几何：返回该页内容区尺寸（毫米） */
export function areaOf(s: DocSettings, index: number, rotate: boolean) {
  const p = PAPERS[s.paper];
  const even = index % 2 === 0;
  // 装订边加在订口：奇数页（正面）在左，偶数页在右
  const gutter = s.mirror || s.gutter > 0 ? (even ? 0 : s.gutter) : 0;
  const m = s.margins;
  const w = p.w - m.left - m.right - gutter;
  const h = p.h - m.top - m.bottom;
  return rotate ? { w: h, h: w } : { w, h };
}

export function pageInsets(s: DocSettings, index: number) {
  const p = PAPERS[s.paper];
  const even = index % 2 === 0;
  const gutter = s.mirror || s.gutter > 0 ? (even ? 0 : s.gutter) : 0;
  const m = s.margins;
  return {
    top: m.top,
    right: m.right + (even ? gutter : 0),
    bottom: m.bottom,
    left: m.left + (even ? 0 : gutter),
    pw: p.w,
    ph: p.h,
  };
}

const esc = (v: string) => v.replace(/"/g, '\\"');

/**
 * 生成排版样式。scope 是根选择器的类名（插件里是 .ntb-root，打印根是同名）。
 * 同一份 CSS 同时给预览和导出用，保证「预览所见 = 导出所得」。
 */
export function buildCss(s: DocSettings, tpl: Template, scope = ".ntb-root"): string {
  const p = PAPERS[s.paper];
  const pal = tpl.palette;
  return `
${scope} {
  --ntb-font-song: ${FONT_SONG};
  --ntb-font-hei: ${FONT_HEI};
  --ntb-font-mono: ${FONT_MONO};
  --ntb-ink: ${pal.ink};
  --ntb-muted: ${pal.muted};
  --ntb-accent: ${pal.accent};
  --ntb-rule: ${pal.rule};
  --ntb-tint: ${pal.tint};
  --ntb-fs: ${s.typo.fontSize}pt;
  --ntb-lh: ${s.typo.lineHeight};
  --ntb-pw: ${p.w}mm;
  --ntb-ph: ${p.h}mm;
  --ntb-cols: ${s.columns};
  --ntb-colgap: ${s.columnGap}mm;
  font-family: ${s.typo.fontFamily === "var(--ntb-font-song)" ? FONT_SONG : s.typo.fontFamily};
  color: var(--ntb-ink);
  font-size: var(--ntb-fs);
  line-height: var(--ntb-lh);
  -webkit-font-smoothing: antialiased;
  font-kerning: normal;
}
${scope} * { box-sizing: border-box; }

/* ---------- 页 ---------- */
${scope} .ntb-page {
  width: var(--ntb-pw);
  height: var(--ntb-ph);
  position: relative;
  overflow: hidden;
  background: #fff;
  color: var(--ntb-ink);
}
${scope} .ntb-area {
  position: absolute;
  display: flex;
  gap: var(--ntb-colgap);
  align-items: stretch;
}
${scope} .ntb-col {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  position: relative;
}
${scope} .ntb-col-inner { position: relative; }

/* ---------- 页眉页脚 ---------- */
${scope} .ntb-hd, ${scope} .ntb-ft {
  position: absolute;
  font-family: ${FONT_HEI};
  font-size: ${s.furniture.headerSize}pt;
  color: var(--ntb-muted);
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
${scope} .ntb-hd { top: calc(var(--ntb-mt, 20mm) - ${Math.max(6, s.furniture.headerSize * 0.52)}mm); }
${scope} .ntb-ft { bottom: calc(var(--ntb-mb, 20mm) - ${Math.max(6, s.furniture.footerSize * 0.5)}mm); font-size: ${s.furniture.footerSize}pt; }
${scope} .ntb-hd.ntb-rule::after, ${scope} .ntb-ft.ntb-rule::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  border-top: 0.4pt solid var(--ntb-rule);
}
${scope} .ntb-hd.ntb-rule::after { bottom: -1.6mm; }
${scope} .ntb-ft.ntb-rule::before { top: -1.6mm; }
${scope} .ntb-pn { font-variant-numeric: tabular-nums; }

/* ---------- 正文排版 ---------- */
${scope} .ntb-doc { text-align: ${s.typo.justify ? "justify" : "left"}; text-justify: inter-ideograph; }
${scope} .ntb-doc p {
  margin: 0 0 ${s.typo.paraSpace}pt;
  text-indent: ${s.typo.paraIndent}em;
  orphans: ${Math.max(2, Math.round(s.typo.lineHeight))};
  widows: ${Math.max(2, Math.round(s.typo.lineHeight))};
  line-height: var(--ntb-lh);
}
${scope} .ntb-doc p.ntb-noindent, ${scope} .ntb-doc li p { text-indent: 0; }
${scope} .ntb-doc h1, ${scope} .ntb-doc h2, ${scope} .ntb-doc h3,
${scope} .ntb-doc h4, ${scope} .ntb-doc h5, ${scope} .ntb-doc h6 {
  font-family: ${FONT_HEI};
  font-weight: 600;
  line-height: 1.35;
  text-indent: 0;
  break-after: avoid;
  page-break-after: avoid;
  margin: ${s.typo.fontSize * 0.9}pt 0 ${s.typo.fontSize * 0.42}pt;
  color: var(--ntb-ink);
}
${scope} .ntb-doc h1 { font-size: calc(var(--ntb-fs) * ${s.typo.titleScale}); margin-top: 0; }
${scope} .ntb-doc h2 { font-size: calc(var(--ntb-fs) * ${(s.typo.titleScale * 0.68).toFixed(2)}); }
${scope} .ntb-doc h3 { font-size: calc(var(--ntb-fs) * ${(s.typo.titleScale * 0.54).toFixed(2)}); }
${scope} .ntb-doc h4, ${scope} .ntb-doc h5, ${scope} .ntb-doc h6 { font-size: 1.02em; }
${scope} .ntb-doc h1 + p, ${scope} .ntb-doc h2 + p, ${scope} .ntb-doc h3 + p { text-indent: ${s.typo.paraIndent}em; }

${scope} .ntb-doc strong { font-weight: 600; }
${scope} .ntb-doc em { font-style: italic; }
${scope} .ntb-doc a { color: var(--ntb-accent); text-decoration: none; border-bottom: 0.4pt solid color-mix(in srgb, var(--ntb-accent) 40%, transparent); }
${scope} .ntb-doc .internal-link, ${scope} .ntb-doc .external-link { color: var(--ntb-accent); text-decoration: none; }
${scope} .ntb-doc mark { background: color-mix(in srgb, var(--ntb-accent) 16%, transparent); color: inherit; padding: 0 1pt; }
${scope} .ntb-doc .ntb-link-mark { color: var(--ntb-muted); font-size: 0.86em; }

/* 列表 */
${scope} .ntb-doc ul, ${scope} .ntb-doc ol { margin: 0 0 ${s.typo.paraSpace}pt; padding-left: 1.55em; }
${scope} .ntb-doc li { margin: 0 0 ${(s.typo.paraSpace * 0.45).toFixed(2)}pt; }
${scope} .ntb-doc li::marker { color: var(--ntb-muted); }
${scope} .ntb-doc li > ul, ${scope} .ntb-doc li > ol { margin-top: ${(s.typo.paraSpace * 0.45).toFixed(2)}pt; }
${scope} .ntb-doc .task-list-item { list-style: none; margin-left: -1.1em; }
${scope} .ntb-doc li.task-list-item > input[type="checkbox"] { display: none; }
${scope} .ntb-doc li.task-list-item::before {
  content: "\\2610"; margin-right: 0.35em; color: var(--ntb-muted); font-family: ${FONT_HEI};
}
${scope} .ntb-doc li.task-list-item[data-task="x"]::before { content: "\\2611"; color: var(--ntb-accent); }
${scope} .ntb-doc .ntb-raw-mermaid, ${scope} .ntb-doc .ntb-raw-math {
  font-family: var(--ntb-font-mono); font-size: 0.82em; color: var(--ntb-muted);
  background: var(--ntb-tint); border-left: 2pt solid var(--ntb-rule); padding: 4pt 6pt;
  white-space: pre-wrap; margin: 0;
}

/* 引用与 Callout */
${scope} .ntb-doc blockquote {
  margin: ${s.typo.fontSize * 0.5}pt 0 ${s.typo.fontSize * 0.6}pt;
  padding: 0 0 0 ${s.typo.fontSize * 0.85}pt;
  border-left: 1.6pt solid var(--ntb-rule);
  color: color-mix(in srgb, var(--ntb-ink) 84%, var(--ntb-muted));
}
${scope} .ntb-doc blockquote p { text-indent: 0; }
${scope} .ntb-doc .callout {
  margin: ${s.typo.fontSize * 0.5}pt 0 ${s.typo.fontSize * 0.6}pt;
  padding: ${s.typo.fontSize * 0.4}pt ${s.typo.fontSize * 0.6}pt;
  border-left: 1.8pt solid var(--ntb-accent);
  background: color-mix(in srgb, var(--ntb-accent) 6%, #fff);
  break-inside: auto;
}
${scope} .ntb-doc .callout-title { font-family: ${FONT_HEI}; font-weight: 600; font-size: 0.96em; margin-bottom: 2pt; }
${scope} .ntb-doc .callout p { text-indent: 0; }

/* 表格 */
${scope} .ntb-table-wrap { margin: ${s.typo.fontSize * 0.42}pt 0 ${s.typo.fontSize * 0.55}pt; }
${scope} .ntb-doc table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.9em;
  line-height: 1.45;
  table-layout: fixed;
}
${scope} .ntb-doc th, ${scope} .ntb-doc td {
  border: 0.4pt solid var(--ntb-rule);
  padding: 2.2pt 3.2pt;
  vertical-align: top;
  text-align: left;
  word-break: break-word;
  overflow-wrap: anywhere;
}
${scope} .ntb-doc thead th {
  background: var(--ntb-tint);
  font-family: ${FONT_HEI};
  font-weight: 600;
  border-bottom: 0.8pt solid var(--ntb-rule);
}
${scope} .ntb-doc tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--ntb-tint) 46%, #fff); }
${scope} .ntb-doc table.ntb-dense { font-size: 0.84em; }

/* 代码 */
${scope} .ntb-doc pre {
  margin: ${s.typo.fontSize * 0.45}pt 0 ${s.typo.fontSize * 0.55}pt;
  padding: 4pt 5pt;
  background: color-mix(in srgb, var(--ntb-tint) 78%, #fff);
  border: 0.4pt solid var(--ntb-rule);
  border-radius: 1.5pt;
  font-family: var(--ntb-font-mono);
  font-size: 0.86em;
  line-height: 1.42;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  tab-size: 2;
}
${scope} .ntb-doc pre.ntb-nowrap { white-space: pre; }
${scope} .ntb-doc pre code { background: none; padding: 0; border: 0; font-size: inherit; }
${scope} .ntb-doc code {
  font-family: var(--ntb-font-mono);
  font-size: 0.88em;
  background: color-mix(in srgb, var(--ntb-tint) 70%, #fff);
  padding: 0 1.5pt;
  border-radius: 1pt;
}
${scope} .ntb-code-line { display: flex; gap: 5pt; }
${scope} .ntb-code-line .ntb-ln {
  flex: 0 0 auto;
  min-width: 1.6em;
  text-align: right;
  color: var(--ntb-muted);
  opacity: 0.62;
  font-variant-numeric: tabular-nums;
  user-select: none;
}
${scope} .ntb-code-line .ntb-lc { flex: 1 1 auto; white-space: pre-wrap; overflow-wrap: anywhere; }
${scope} .ntb-doc pre.ntb-nowrap .ntb-lc { white-space: pre; }
${scope} .ntb-hl-k { color: #8b2f6b; }
${scope} .ntb-hl-s { color: #2f6b4f; }
${scope} .ntb-hl-c { color: var(--ntb-muted); font-style: italic; }
${scope} .ntb-hl-n { color: #7a4a1f; }
${scope} .ntb-hl-f { color: #2b4a8b; }

/* 图 */
${scope} .ntb-doc figure { margin: ${s.typo.fontSize * 0.5}pt 0 ${s.typo.fontSize * 0.6}pt; text-align: center; }
${scope} .ntb-doc img { max-width: 100%; height: auto; display: block; margin: 0 auto; }
${scope} .ntb-doc figcaption, ${scope} .ntb-figcap {
  font-family: ${FONT_HEI};
  font-size: 0.82em;
  color: var(--ntb-muted);
  text-align: center;
  margin-top: 2.5pt;
  text-indent: 0;
}
${scope} .ntb-doc .ntb-img-missing {
  border: 0.5pt dashed var(--ntb-rule);
  padding: 8pt;
  text-align: center;
  color: var(--ntb-muted);
  font-family: ${FONT_HEI};
  font-size: 0.84em;
  text-indent: 0;
}

/* 公式与 mermaid */
${scope} .ntb-doc .math, ${scope} .ntb-doc .math-block, ${scope} .ntb-doc mjx-container {
  font-size: 1em;
  text-indent: 0;
  overflow-x: visible;
}
${scope} .ntb-doc .math-block { display: block; text-align: center; margin: ${s.typo.fontSize * 0.4}pt 0; }
${scope} .ntb-doc .mermaid, ${scope} .ntb-doc .mermaid-rendered { text-align: center; }
${scope} .ntb-doc svg { max-width: 100%; height: auto; }

/* 分隔线 */
${scope} .ntb-doc hr { border: 0; border-top: 0.4pt solid var(--ntb-rule); margin: ${s.typo.fontSize}pt 0; }

/* ---------- 封面 ---------- */
${scope} .ntb-cover {
  position: absolute;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 22mm;
}
${scope} .ntb-cover.left { align-items: flex-start; text-align: left; }
${scope} .ntb-cover.center { align-items: center; text-align: center; }
${scope} .ntb-cover .ct {
  font-family: ${FONT_HEI};
  font-weight: 700;
  font-size: ${(s.typo.fontSize * 2.5).toFixed(1)}pt;
  line-height: 1.35;
  letter-spacing: 0.04em;
}
${scope} .ntb-cover .cs { font-family: ${FONT_HEI}; font-size: ${(s.typo.fontSize * 1.3).toFixed(1)}pt; color: var(--ntb-muted); margin-top: 6mm; }
${scope} .ntb-cover .cr { width: 34mm; height: 1.2pt; background: var(--ntb-accent); margin: 8mm 0; }
${scope} .ntb-cover .ca { font-family: ${FONT_HEI}; font-size: ${s.typo.fontSize}pt; margin-top: 16mm; }
${scope} .ntb-cover .cd { font-family: ${FONT_HEI}; font-size: ${(s.typo.fontSize * 0.9).toFixed(1)}pt; color: var(--ntb-muted); margin-top: 3mm; }

/* ---------- 目录 ---------- */
${scope} .ntb-toc-title {
  font-family: ${FONT_HEI};
  font-size: ${(s.typo.fontSize * 1.7).toFixed(1)}pt;
  font-weight: 700;
  letter-spacing: 0.16em;
  margin-bottom: ${s.typo.fontSize * 1.2}pt;
}
${scope} .ntb-toc-row { display: flex; align-items: baseline; text-indent: 0; margin: 0 0 ${s.typo.fontSize * 0.28}pt; }
${scope} .ntb-toc-row.lv2 { padding-left: 1.8em; font-size: 0.95em; }
${scope} .ntb-toc-row.lv3 { padding-left: 3.6em; font-size: 0.9em; color: var(--ntb-muted); }
${scope} .ntb-toc-row .tx { flex: 0 1 auto; max-width: 100%; }
${scope} .ntb-toc-row .dots { flex: 1 1 auto; border-bottom: 0.5pt dotted var(--ntb-rule); margin: 0 3pt; transform: translateY(-0.9mm); min-width: 6mm; }
${scope} .ntb-toc-row .pg { flex: 0 0 auto; font-variant-numeric: tabular-nums; }

/* ---------- 章首页 ---------- */
${scope} .ntb-chapter-head { display: flex; flex-direction: column; justify-content: flex-end; height: 100%; padding-bottom: 12mm; }
${scope} .ntb-chapter-head .num {
  font-family: ${FONT_HEI};
  font-size: ${(s.typo.fontSize * 4.2).toFixed(0)}pt;
  font-weight: 700;
  color: color-mix(in srgb, var(--ntb-accent) 22%, #fff);
  line-height: 1;
  margin-bottom: -2mm;
}
${scope} .ntb-chapter-head .ttl { font-family: ${FONT_HEI}; font-size: ${(s.typo.fontSize * 2.1).toFixed(1)}pt; font-weight: 700; line-height: 1.4; }
${scope} .ntb-chapter-head .rule { width: 100%; height: 0.8pt; background: var(--ntb-rule); margin-top: 6mm; }
${scope} .ntb-chapter-head.sub { justify-content: flex-start; height: auto; padding: 6mm 0 4mm; }

/* ---------- 打印 ---------- */
${scope} .ntb-page + .ntb-page { margin-top: 6mm; }

/* ---------- 模板差异 ---------- */
${templateCss(tpl.id, s)}
`;
}

function templateCss(id: string, s: DocSettings): string {
  const fs = s.typo.fontSize;
  switch (id) {
    case "report":
      return `
.ntb-doc h1 { text-align: center; letter-spacing: 0.02em; }
.ntb-doc h2 { border-bottom: 0.6pt solid var(--ntb-rule); padding-bottom: 2pt; }
.ntb-doc h2::before { content: ""; display: inline-block; width: 3pt; height: 0.86em; background: var(--ntb-accent); margin-right: 5pt; transform: translateY(0.6pt); }
.ntb-doc p { text-align: justify; }
`;
    case "minutes":
      return `
.ntb-doc h2 { background: var(--ntb-tint); padding: 2.5pt 5pt; border-left: 2.4pt solid var(--ntb-accent); font-size: calc(var(--ntb-fs) * 0.98); }
.ntb-doc ul { padding-left: 1.3em; }
.ntb-doc table { font-size: 0.88em; }
.ntb-doc table th { background: color-mix(in srgb, var(--ntb-accent) 10%, #fff); }
`;
    case "handover":
      return `
.ntb-doc h2 { display: flex; align-items: center; gap: 6pt; }
.ntb-doc h2::after { content: ""; flex: 1; border-top: 0.5pt solid var(--ntb-rule); }
.ntb-doc .task-list-item { font-family: var(--ntb-font-hei); }
.ntb-doc table th { background: color-mix(in srgb, var(--ntb-accent) 8%, #fff); }
.ntb-doc blockquote { background: var(--ntb-tint); border-left-color: var(--ntb-accent); padding: 4pt 6pt; }
`;
    case "lecture":
      return `
.ntb-doc h2 { counter-increment: lec; }
.ntb-doc h2::before { content: counter(lec) ". "; color: var(--ntb-accent); font-weight: 700; }
.ntb-doc { counter-reset: lec; }
.ntb-doc .callout { border-left-width: 2.4pt; }
.ntb-doc blockquote { border-left: 0.6pt solid var(--ntb-rule); font-size: 0.96em; }
`;
    case "manual":
      return `
.ntb-doc h2 { font-family: var(--ntb-font-mono); font-size: calc(var(--ntb-fs) * 1.16); letter-spacing: -0.01em; }
.ntb-doc pre { font-size: 0.82em; }
.ntb-doc table { font-size: 0.84em; }
.ntb-doc code { font-size: 0.9em; }
`;
    case "anthology":
      return `
.ntb-doc h1 { font-size: calc(var(--ntb-fs) * 1.5); text-align: left; }
.ntb-doc blockquote { font-size: 0.94em; border-left: 1pt solid var(--ntb-accent); background: none; }
.ntb-col { font-size: ${(fs * 0.99).toFixed(2)}pt; }
`;
    case "portfolio":
      return `
.ntb-doc img { max-height: 108mm; object-fit: contain; }
.ntb-doc h1 { font-weight: 700; letter-spacing: 0.02em; }
.ntb-doc h2 { font-weight: 500; color: var(--ntb-muted); font-size: calc(var(--ntb-fs) * 1.05); }
.ntb-doc figure img { max-height: 96mm; }
`;
    case "worksheet":
      return `
.ntb-doc ol { padding-left: 1.9em; }
.ntb-doc ol > li { margin-bottom: ${(fs * 0.9).toFixed(1)}pt; }
.ntb-doc ol > li::marker { font-weight: 700; color: var(--ntb-accent); }
.ntb-doc hr { border-top: 0.5pt dashed var(--ntb-rule); margin: ${fs}pt 0 ${fs * 1.2}pt; }
.ntb-doc p { text-indent: 0; }
`;
    case "longform":
      return `
.ntb-doc p { text-indent: ${s.typo.paraIndent}em; margin-bottom: 0; }
.ntb-doc h2 { margin-top: ${fs * 1.2}pt; }
`;
    case "article":
    default:
      return `
.ntb-doc h1 { text-align: left; }
.ntb-doc blockquote { font-size: 0.97em; }
`;
  }
}

/** 打印时的页规则：纸张由 @page 决定，页与页用绝对定位摞起来 */
export function buildPrintCss(s: DocSettings, scope = ".ntb-print-root"): string {
  const p = PAPERS[s.paper];
  return `
@page { size: ${p.w}mm ${p.h}mm; margin: 0; }
html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
${scope} { position: relative; margin: 0 !important; padding: 0 !important; }
/* 逐页绝对定位：比 break-after 更可控，实测不会在每页后多顶一张空白页 */
${scope} .ntb-page {
  position: absolute !important;
  left: 0 !important;
  margin: 0 !important;
  box-shadow: none !important;
  transform: none !important;
  zoom: 1 !important;
  width: ${p.w}mm !important;
  height: ${p.h}mm !important;
  break-after: auto !important;
  page-break-after: auto !important;
  break-inside: avoid;
}
`;
}
