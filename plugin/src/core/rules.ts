import type { BlockKind, ElemOpts, ScopedRule, SourceBlock } from "./types";

/**
 * 局部规则落到 DOM 上。
 * block 级规则用 blockId 精确匹配；chapter / doc 级按类型（和章节）匹配。
 */
export function applyRules(
  blocks: HTMLElement[],
  sources: SourceBlock[],
  rules: ScopedRule[]
): void {
  if (!rules.length) return;
  const byId = new Map(sources.map((s) => [s.id, s]));

  for (const rule of rules) {
    for (const el of blocks) {
      const id = el.dataset.ntbId ?? "";
      const kind = el.dataset.ntbKind as BlockKind | undefined;
      if (!kind || !rule.types.includes(kind)) continue;
      if (rule.scope === "block" && rule.blockId !== id) continue;
      if (rule.scope === "chapter") {
        const src = byId.get(id);
        if (!src || src.chapterIndex !== rule.chapterIndex) continue;
      }
      apply(el, rule.opts, byId.get(id));
    }
  }
}

function apply(el: HTMLElement, o: ElemOpts, src?: SourceBlock) {
  if (o.hide) {
    el.dataset.ntbHidden = "1";
    el.style.display = "none";
    if (src) src.mustAppear = false;
    return;
  }
  if (o.breakBefore) el.dataset.ntbBreak = "page";
  if (o.keepWithNext) el.dataset.ntbBreak = "avoid";
  if (o.rotate) el.dataset.ntbRotate = "1";
  if (o.align) el.style.textAlign = o.align;
  if (o.fontSize) el.style.fontSize = `${o.fontSize}pt`;
  if (o.maxHeightPct) {
    const img = el.querySelector("img") ?? el;
    (img as HTMLElement).style.maxHeight = `calc(var(--ntb-ph) * ${o.maxHeightPct / 100})`;
  }
  if (typeof o.wrap === "boolean") {
    const pre = el.matches("pre") ? el : el.querySelector("pre");
    if (pre) pre.classList.toggle("ntb-nowrap", !o.wrap);
  }
  if (typeof o.repeatHeader === "boolean") {
    el.dataset.ntbRepeat = o.repeatHeader ? "1" : "0";
    const wrap = el.classList.contains("ntb-table-wrap") ? el : el.querySelector(".ntb-table-wrap");
    if (wrap) (wrap as HTMLElement).dataset.ntbRepeat = o.repeatHeader ? "1" : "0";
  }
}
