import type {
  DocSettings,
  LayoutWarning,
  PagePlan,
  PaginationResult,
  PlacedBlock,
  SourceBlock,
} from "./types";
import { PAPERS } from "./types";
import type { Template } from "./templates";
import { pageInsets } from "./css";

const MM = 96 / 25.4;

export interface PaginateOpts {
  settings: DocSettings;
  template: Template;
  sources: SourceBlock[];
}

const px = (mm: number) => Math.round(mm * MM * 100) / 100;

function mk<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      return (n as Text).data.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode())) out.push(n as Text);
  return out;
}

/** 保留前 k 个字符（keep=true）或删除前 k 个字符 */
function cutClone(src: HTMLElement, k: number, keepPrefix: boolean): HTMLElement {
  const clone = src.cloneNode(true) as HTMLElement;
  clone.removeAttribute("data-ntb-id");
  const nodes = textNodes(clone);
  let acc = 0;
  for (const n of nodes) {
    const start = acc;
    const end = acc + n.data.length;
    acc = end;
    if (keepPrefix) {
      if (end <= k) continue;
      n.data = start >= k ? "" : n.data.slice(0, k - start);
    } else {
      if (end <= k) n.data = "";
      else if (start >= k) continue;
      else n.data = n.data.slice(k - start);
    }
  }
  return clone;
}

function snapBreak(nodes: Text[], k: number): number {
  if (k <= 0) return k;
  const full = nodes.map((n) => n.data).join("");
  if (k >= full.length) return k;
  const from = Math.max(0, k - 14);
  const back = full.slice(from, k);
  const m = /[\s。，、；：？！）”』"']$/u.exec(back);
  return m ? from + m.index + 1 : k;
}

interface PageRec {
  el: HTMLElement;
  cols: HTMLElement[];
  kind: PagePlan["kind"];
  plan: PagePlan;
}

export class Paginator {
  private s: DocSettings;
  private tpl: Template;
  private root: HTMLElement;
  private pages: PageRec[] = [];
  private colIdx = 0;
  private placed: PlacedBlock[] = [];
  private warnings: LayoutWarning[] = [];
  private headings: PaginationResult["headings"] = [];
  private srcById = new Map<string, SourceBlock>();

  constructor(root: HTMLElement, opts: PaginateOpts) {
    this.root = root;
    this.s = opts.settings;
    this.tpl = opts.template;
    for (const b of opts.sources) this.srcById.set(b.id, b);
    this.root.innerHTML = "";
    this.root.classList.add("ntb-root", `ntb-tpl-${this.tpl.id}`);
  }

  layout(blocks: HTMLElement[]): PaginationResult {
    const list = blocks.slice();
    this.newPage();
    let i = 0;
    let guard = 0;
    while (i < list.length) {
      if (guard++ > 40000) throw new Error("排版陷入死循环，已中止");
      const el = list[i];
      const consumed = this.place(el, list, i);
      i += Math.max(1, consumed);
    }
    this.finalize();
    return {
      pages: this.pages.map((p) => p.plan),
      placed: this.placed,
      headings: this.headings,
      warnings: this.warnings,
    };
  }

  // ---------- 骨架 ----------

  private get page(): PageRec {
    return this.pages[this.pages.length - 1];
  }

  private get col(): HTMLElement {
    return this.page.cols[this.colIdx];
  }

  private newPage(rotate = false) {
    const index = this.pages.length + 1;
    const p = PAPERS[this.s.paper];
    const page = mk("div", "ntb-page") as HTMLElement;
    page.dataset.page = String(index);
    page.style.width = `${p.w}mm`;
    page.style.height = `${p.h}mm`;
    const ins = pageInsets(this.s, index);
    const area = mk("div", "ntb-area") as HTMLElement;
    area.style.top = `${ins.top}mm`;
    area.style.left = `${ins.left}mm`;
    area.style.width = `${ins.pw - ins.left - ins.right}mm`;
    area.style.height = `${p.h - ins.top - ins.bottom}mm`;
    page.appendChild(area);

    const n = Math.max(1, this.s.columns);
    const cols: HTMLElement[] = [];
    for (let c = 0; c < n; c++) {
      const col = mk("div", "ntb-col ntb-doc") as HTMLElement;
      col.dataset.col = String(c);
      col.style.width =
        n === 1 ? "100%" : `calc((100% - ${(n - 1) * this.s.columnGap}mm) / ${n})`;
      area.appendChild(col);
      cols.push(col);
    }

    const plan: PagePlan = {
      index,
      kind: "body",
      label: "",
      columns: n,
      rotate,
    };
    const rec: PageRec = { el: page, cols, kind: "body", plan };
    this.root.appendChild(page);
    this.pages.push(rec);
    this.colIdx = 0;
    if (rotate) this.makeLandscape(rec);
    this.addFurniture(rec);
  }

  /** 横向页：A4 纸仍是纵向，内容旋转 90°（Chromium 打印不支持逐页改纸张） */
  private makeLandscape(rec: PageRec) {
    const p = PAPERS[this.s.paper];
    const ins = pageInsets(this.s, rec.plan.index);
    const area = rec.el.querySelector<HTMLElement>(".ntb-area")!;
    const w = p.h - ins.top - ins.bottom;
    const h = p.w - ins.left - ins.right;
    rec.el.classList.add("ntb-landscape");
    area.style.width = `${w}mm`;
    area.style.height = `${h}mm`;
    area.style.left = "0";
    area.style.top = "0";
    area.style.transformOrigin = "top left";
    area.style.transform = `translate(${ins.left + h}mm, ${ins.top}mm) rotate(90deg)`;
    rec.plan.rotate = true;
  }

  private addFurniture(rec: PageRec) {
    const ins = pageInsets(this.s, rec.plan.index);
    const w = ins.pw - ins.left - ins.right;
    const f = this.s.furniture;
    if (f.headerOn) {
      const hd = mk("div", "ntb-hd");
      if (f.headerRule) hd.classList.add("ntb-rule");
      hd.dataset.slot = "hd";
      hd.style.left = `${ins.left}mm`;
      hd.style.width = `${w}mm`;
      hd.style.textAlign = f.headerAlign;
      rec.el.appendChild(hd);
    }
    if (f.footerOn) {
      const ft = mk("div", "ntb-ft");
      if (f.footerRule) ft.classList.add("ntb-rule");
      ft.dataset.slot = "ft";
      ft.style.left = `${ins.left}mm`;
      ft.style.width = `${w}mm`;
      ft.style.textAlign = f.footerAlign;
      rec.el.appendChild(ft);
    }
  }

  /** 换栏；栏用完换页 */
  private advance() {
    if (this.colIdx + 1 < this.page.cols.length) {
      this.colIdx++;
      return;
    }
    this.newPage();
  }

  private overflow(col: HTMLElement): boolean {
    return col.scrollHeight - col.clientHeight > 1;
  }

  private clipWarn(el: HTMLElement) {
    const src = this.srcById.get(el.dataset.ntbId ?? "");
    this.warnings.push({
      kind: "clipped",
      blockId: src?.id,
      page: this.page.plan.index,
      srcPath: src?.srcPath,
      srcLine: src?.srcLine,
      detail: "整块超过一页且无法拆分，已裁切",
    });
  }

  private hasContent(): boolean {
    return this.page.cols.some((c) => c.childElementCount > 0);
  }

  // ---------- 放置 ----------

  private place(el: HTMLElement, list: HTMLElement[], i: number): number {
    // 封面：独占一页、绝对定位
    if (el.dataset.ntbPage === "cover") {
      if (this.hasContent()) this.newPage();
      const rec = this.page;
      rec.kind = "cover";
      rec.plan.kind = "cover";
      el.style.position = "absolute";
      el.style.inset = "0";
      rec.el.appendChild(el);
      this.record(el, 0, false, 1);
      this.newPage();
      return 1;
    }

    if (el.dataset.ntbBreak === "page" && this.hasContent()) {
      this.newPage();
    }

    // 章首页（大号码）：独占整页
    if (el.dataset.ntbPage === "chapter") {
      // 必须先换页。这一块是 height:100% 的整页版式，紧跟着上一页的内容往下排，
      // 它会从半页处开始、再占满一整页高度，直接顶出页底被裁掉：
      // 章标题跑到上一页末尾，页码全错，成品还少一页。
      if (this.hasContent()) this.newPage();
      this.col.appendChild(el);
      this.page.kind = "chapter";
      this.page.plan.kind = "chapter";
      if (this.overflow(this.col)) this.clipWarn(el);
      this.record(el, this.colIdx, this.overflow(this.col), 1);
      this.newPage();
      return 1;
    }

    // 横向页：只放这一块，放完就翻页
    if (el.dataset.ntbRotate === "1") {
      if (this.hasContent() || this.page.plan.rotate) this.newPage(true);
      else if (!this.page.plan.rotate) this.makeLandscape(this.page);
      this.col.appendChild(el);
      if (this.overflow(this.col)) this.clipWarn(el);
      this.record(el, this.colIdx, this.overflow(this.col), 1);
      this.newPage();
      return 1;
    }

    this.col.appendChild(el);

    if (!this.overflow(this.col)) {
      this.record(el, this.colIdx, false, 1);
      return this.keepWithNext(el, list, i);
    }

    const rest = this.split(el, this.col);
    if (rest) {
      this.record(el, this.colIdx, false, 1);
      list.splice(i + 1, 0, rest);
      this.advance();
      return 1;
    }

    // 拆不动：整块挪
    el.remove();
    this.advance();
    this.col.appendChild(el);
    if (this.overflow(this.col)) {
      const src = this.srcById.get(el.dataset.ntbId ?? "");
      const k = el.dataset.ntbKind ?? "unknown";
      this.warnings.push({
        kind: k === "image" ? "missing-image" : k === "table" ? "wide-table" : k === "code" ? "long-code" : "clipped",
        blockId: src?.id,
        page: this.page.plan.index,
        srcPath: src?.srcPath,
        srcLine: src?.srcLine,
        detail:
          k === "table"
            ? "表格单行高度超过整页，已裁切"
            : k === "code"
              ? "代码块单行超过整页，已裁切"
              : "整块超过一页且无法拆分，已裁切",
      });
      this.record(el, this.colIdx, true, 1);
      return 1;
    }
    this.record(el, this.colIdx, false, 1);
    return this.keepWithNext(el, list, i);
  }

  /** 标题留在栏底、与后文分家时，把标题一起挪到下一栏 */
  private keepWithNext(el: HTMLElement, _list: HTMLElement[], _i: number): number {
    if (el.dataset.ntbBreak !== "avoid") return 1;
    if (this.col.firstElementChild === el) return 1;
    const lh = this.lineHeight(this.col);
    // scrollHeight 在 overflow:hidden 下会被夹到 clientHeight，只能按最后一个子元素的底边算
    const remain = this.col.clientHeight - this.usedHeight(this.col);
    if (remain >= lh * 2) return 1;
    el.remove();
    this.advance();
    this.col.appendChild(el);
    const hit = this.placed[this.placed.length - 1];
    if (hit) {
      hit.page = this.page.plan.index;
      hit.column = this.colIdx;
    }
    return 1;
  }

  private usedHeight(col: HTMLElement): number {
    const last = col.lastElementChild as HTMLElement | null;
    if (!last) return 0;
    return last.offsetTop + last.offsetHeight;
  }

  private lineHeight(host: HTMLElement): number {
    const probe = mk("div");
    probe.textContent = "国";
    probe.style.cssText =
      "position:absolute;visibility:hidden;white-space:nowrap;margin:0;padding:0;line-height:inherit;font-size:inherit;";
    host.appendChild(probe);
    const h = probe.offsetHeight || 16;
    probe.remove();
    return h;
  }

  private record(el: HTMLElement, col: number, clipped: boolean, part: number) {
    const id = el.dataset.ntbId ?? "";
    this.placed.push({
      id,
      kind: (el.dataset.ntbKind ?? "unknown") as PlacedBlock["kind"],
      page: this.page.plan.index,
      column: col,
      clipped,
      part,
    });
    const src = this.srcById.get(id);
    const kind = el.dataset.ntbKind;
    // 章首页（kind=chapter）本身就是一级标题，目录里必须有它，否则合订本的目录只剩小节
    if ((kind === "heading" || kind === "chapter") && src?.level && !el.dataset.ntbToc) {
      this.headings.push({
        id,
        level: src.level,
        text: src.text,
        page: this.page.plan.index,
        chapterIndex: src.chapterIndex,
      });
    }
  }

  // ---------- 拆分 ----------

  private split(node: HTMLElement, col: HTMLElement): HTMLElement | null {
    switch (node.dataset.ntbKind) {
      case "table":
        return this.splitTable(node, col);
      case "code":
        return this.splitCode(node, col);
      case "list":
        return this.splitList(node, col);
      case "para":
      case "quote":
        return this.splitPara(node, col);
      case "callout":
        // 提示块常常一整块塞着标题、段落、表格：先看能不能整块按文字拆，
        // 不能就按内部子元素切成两半（续页保留外框和标题）
        return this.splitPara(node, col) ?? this.splitBox(node, col);
      default:
        return null;
    }
  }

  private splitTable(node: HTMLElement, col: HTMLElement): HTMLElement | null {
    const wrap = node.closest<HTMLElement>(".ntb-table-wrap") ?? node;
    const table = (node.tagName === "TABLE" ? node : wrap.querySelector("table")) as HTMLTableElement | null;
    if (!table) return null;
    const tbody = table.tBodies[0];
    if (!tbody || tbody.rows.length < 2) return null;
    const moved: HTMLTableRowElement[] = [];
    while (this.overflow(col) && tbody.rows.length > 1) {
      const r = tbody.rows[tbody.rows.length - 1];
      moved.unshift(r.cloneNode(true) as HTMLTableRowElement);
      r.remove();
    }
    if (!moved.length || this.overflow(col)) {
      for (const r of moved) tbody.appendChild(r);
      return null;
    }
    const clone = table.cloneNode(false) as HTMLTableElement;
    const repeat = (wrap.dataset.ntbRepeat ?? table.dataset.ntbRepeat ?? "1") === "1";
    if (repeat && table.tHead) {
      clone.appendChild(table.tHead.cloneNode(true));
    }
    const body = mk("tbody");
    for (const r of moved) body.appendChild(r);
    clone.appendChild(body);
    const wrap2 = mk("div", "ntb-table-wrap");
    wrap2.dataset.ntbKind = "table";
    wrap2.dataset.ntbCont = "1";
    wrap2.dataset.ntbId = wrap.dataset.ntbId ?? "";
    wrap2.dataset.ntbRepeat = repeat ? "1" : "0";
    wrap2.appendChild(clone);
    return wrap2;
  }

  private splitCode(pre: HTMLElement, col: HTMLElement): HTMLElement | null {
    const all = () => Array.from(pre.querySelectorAll<HTMLElement>(".ntb-code-line"));
    if (all().length < 2) return null;
    const moved: HTMLElement[] = [];
    while (this.overflow(col) && all().length > 1) {
      const lines = all();
      const last = lines[lines.length - 1];
      moved.unshift(last.cloneNode(true) as HTMLElement);
      last.remove();
    }
    if (!moved.length || this.overflow(col)) {
      for (const l of moved) pre.appendChild(l);
      return null;
    }
    const clone = pre.cloneNode(false) as HTMLElement;
    clone.dataset.ntbCont = "1";
    for (const l of moved) clone.appendChild(l);
    return clone;
  }

  private splitList(list: HTMLElement, col: HTMLElement): HTMLElement | null {
    const total = list.children.length;
    if (total < 2) return null;
    const moved: HTMLElement[] = [];
    while (this.overflow(col) && list.children.length > 1) {
      const last = list.lastElementChild as HTMLElement;
      moved.unshift(last.cloneNode(true) as HTMLElement);
      last.remove();
    }
    if (!moved.length || this.overflow(col)) {
      for (const m of moved) list.appendChild(m);
      return null;
    }
    const clone = list.cloneNode(false) as HTMLElement;
    clone.dataset.ntbCont = "1";
    if (list.tagName === "OL") {
      const start = Number((list as HTMLOListElement).getAttribute("start") || 1);
      clone.setAttribute("start", String(start + (total - moved.length)));
    }
    for (const m of moved) clone.appendChild(m);
    return clone;
  }

  /** 段落按行拆 */
  private splitPara(node: HTMLElement, col: HTMLElement): HTMLElement | null {
    // 含着图片/表格/公式的段落没法按字符切（切了也不是原文的顺序）
    if (node.querySelector("img, table, pre, svg, .internal-embed, .callout, mjx-container")) return null;
    const nodes = textNodes(node);
    const L = nodes.reduce((a, n) => a + n.data.length, 0);
    if (L < 30) return null;
    const lh = this.lineHeight(col);
    const avail = col.clientHeight - node.offsetTop - 1;
    if (avail < lh * 2) return null;

    const probe = mk("div");
    probe.style.cssText = `position:absolute;visibility:hidden;left:-100000px;top:0;width:${col.clientWidth}px;`;
    probe.className = "ntb-doc";
    col.appendChild(probe);
    const measure = (k: number) => {
      const c = cutClone(node, k, true);
      c.style.margin = "0";
      probe.innerHTML = "";
      probe.appendChild(c);
      return c.offsetHeight;
    };

    let lo = 1;
    let hi = L - 1;
    if (measure(lo) > avail) {
      probe.remove();
      return null;
    }
    let best = 0;
    let guard = 0;
    while (lo <= hi && guard++ < 40) {
      const mid = (lo + hi) >> 1;
      if (measure(mid) <= avail) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (!best) {
      probe.remove();
      return null;
    }
    best = snapBreak(nodes, best);

    const prefix = cutClone(node, best, true);
    prefix.style.marginBottom = "0";
    probe.innerHTML = "";
    probe.appendChild(prefix);
    if (prefix.offsetHeight < lh * 2 - 1) {
      probe.remove();
      return null;
    }

    const suffix = cutClone(node, best, false);
    suffix.classList.add("ntb-noindent");
    suffix.dataset.ntbSplit = "1";
    suffix.dataset.ntbId = node.dataset.ntbId ?? "";
    probe.innerHTML = "";
    probe.appendChild(suffix);
    if (suffix.offsetHeight < lh * 2 - 1) {
      probe.remove();
      return null;
    }
    const suffixOut = probe.firstElementChild as HTMLElement;
    suffixOut.remove();
    probe.remove();

    node.replaceWith(prefix);
    return suffixOut;
  }

  /**
   * 容器型块（提示块）按内部子元素切。
   *
   * 原来的做法是「拆不动就整块挪，挪了还超页就裁掉」。但 Obsidian 的提示块常常
   * 一整块装着标题、好几段正文、两张表，只要超过一页就整块被裁，内容会真的丢。
   * 这里找到提示块真正的内容容器（`.callout-content`，外面还套一层渲染宿主），
   * 从尾部往前挪子元素；续页复制一份外框，标题照旧。只剩一个孩子时，
   * 就把这个孩子自己拆（表格切行 / 段落切行）。
   */
  private splitBox(node: HTMLElement, col: HTMLElement): HTMLElement | null {
    const content = this.calloutContent(node);
    if (!content || !content.children.length) return null;

    const reborn = (put: (c: HTMLElement) => void): HTMLElement => {
      const clone = node.cloneNode(true) as HTMLElement;
      const cbody = this.calloutContent(clone) ?? clone;
      cbody.innerHTML = "";
      put(cbody);
      clone.dataset.ntbCont = "1";
      clone.dataset.ntbId = node.dataset.ntbId ?? "";
      return clone;
    };

    // 只剩一个孩子还超页：把这个孩子自己拆开，后半段仍包在同样的外框里
    if (content.children.length === 1) {
      const only = content.firstElementChild as HTMLElement;
      const rest = this.splitInside(only, col);
      return rest ? reborn((c) => c.appendChild(rest)) : null;
    }

    const moved: HTMLElement[] = [];
    // 先按整块搬，搬到一个能放下为止；搬完还超页说明剩下的部分本身超页
    while (this.overflow(col) && content.children.length > 1) {
      const last = content.lastElementChild as HTMLElement;
      moved.unshift(last.cloneNode(true) as HTMLElement);
      last.remove();
    }
    if (!moved.length || this.overflow(col)) {
      for (const m of moved) content.appendChild(m);
      return null;
    }
    return reborn((c) => {
      for (const m of moved) c.appendChild(m);
    });
  }

  /** 提示块里真正装内容的容器；不是提示块就返回 null */
  private calloutContent(root: HTMLElement): HTMLElement | null {
    if (root.classList?.contains("callout-content")) return root;
    return root.querySelector<HTMLElement>(".callout-content");
  }

  /** 把容器里唯一的那个孩子自己拆开：表格切行、段落切行 */
  private splitInside(el: HTMLElement, col: HTMLElement): HTMLElement | null {
    const table = el.tagName === "TABLE" ? el : el.querySelector("table");
    if (table) return this.splitTable(el, col);
    if (el.matches("pre, .ntb-code")) return this.splitCode(el, col);
    if (el.tagName === "UL" || el.tagName === "OL") return this.splitList(el, col);
    // 纯文本容器：套一层 .ntb-doc 让行高测量和正文一致
    const had = el.classList.contains("ntb-doc");
    if (!had) el.classList.add("ntb-doc");
    const rest = this.splitPara(el, col);
    if (!had && !rest) el.classList.remove("ntb-doc");
    return rest;
  }

  // ---------- 收尾 ----------

  private finalize() {
    const total = this.pages.length;
    let bodyStart = this.pages.findIndex((p) => p.kind !== "cover" && p.kind !== "toc");
    if (bodyStart < 0) bodyStart = 0;

    this.pages.forEach((rec, idx) => {
      const first = rec.cols[0].firstElementChild as HTMLElement | null;
      if (rec.kind !== "cover" && rec.kind !== "toc") {
        rec.kind = first?.dataset.ntbKind === "chapter" ? "chapter" : "body";
      }
      rec.plan.kind = rec.kind;
      const chNo = first?.dataset.ntbChapter ?? "";
      const chTitle = first?.dataset.ntbChapterTitle ?? "";
      rec.plan.chapterTitle = chTitle || undefined;

      let label = "";
      if (rec.kind === "cover") label = "";
      else if (idx < bodyStart) label = this.s.frontMatterRoman ? roman(idx - (this.pages[0].kind === "cover" ? 1 : 0) + 1) : "";
      else label = String(this.s.firstPageNumber + (idx - bodyStart));
      rec.plan.label = label;

      const vars: Record<string, string> = {
        book: this.s.cover.title || this.firstH1(),
        chapter: chTitle,
        chapterNo: chNo,
        page: label,
        total: String(this.s.firstPageNumber + (total - bodyStart) - 1),
      };
      for (const slot of ["hd", "ft"]) {
        const node = rec.el.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
        if (!node) continue;
        const isHd = slot === "hd";
        const on = isHd ? this.s.furniture.headerOn : this.s.furniture.footerOn;
        const raw = isHd ? this.s.furniture.headerText : this.s.furniture.footerText;
        const pn = isHd ? this.s.furniture.headerPageNo : this.s.furniture.footerPageNo;
        // 封面不排页眉页脚。模板的页眉常写 {{book}}，不挡掉的话书名会出现在封面上，
        // 预览里因为封面元素压在页眉之上看不见，打印出来却有——两侧不一致最容易被当成 bug。
        const isCover = rec.kind === "cover";
        const text = isCover ? "" : subst(raw, vars);
        node.textContent = "";
        if (text) node.appendChild(document.createTextNode(text));
        if (pn && !isCover) {
          if (text) node.appendChild(document.createTextNode("　"));
          const sp = mk("span", "ntb-pn");
          sp.textContent = label;
          node.appendChild(sp);
        }
      }
      // 页码在页眉时，页脚不再重复
      const ft = rec.el.querySelector<HTMLElement>('[data-slot="ft"]');
      if (ft && this.s.furniture.headerOn && this.s.furniture.headerPageNo && !this.s.furniture.footerOn) ft.textContent = "";
    });
  }

  private firstH1(): string {
    return this.headings.find((h) => h.level === 1)?.text ?? "";
  }
}

function subst(tpl: string, vars: Record<string, string>): string {
  return (tpl || "").replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
}

function roman(n: number): string {
  if (n <= 0) return "";
  const map: [number, string][] = [
    [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let s = "";
  let v = n;
  for (const [num, sym] of map) {
    while (v >= num) {
      s += sym;
      v -= num;
    }
  }
  return s;
}

export const mmToPx = px;
