import { PAPERS, type DocSettings } from "./types";

/**
 * 把页面按「第 i 页 = 第 i 张纸」摞好：
 * 绝对定位在 i × 页高处，容器撑到总高。打印时一行 CSS 都不用算断页。
 */
export function stackPrintPages(root: HTMLElement, settings: DocSettings): number {
  const p = PAPERS[settings.paper];
  const pages = Array.from(root.querySelectorAll<HTMLElement>(".ntb-page"));
  pages.forEach((el, i) => {
    el.style.position = "absolute";
    el.style.left = "0";
    el.style.top = `${i * p.h}mm`;
    el.style.margin = "0";
    el.style.boxShadow = "none";
    el.style.transform = "none";
    el.style.width = `${p.w}mm`;
    el.style.height = `${p.h}mm`;
  });
  root.style.position = "relative";
  root.style.height = `${pages.length * p.h}mm`;
  return pages.length;
}
