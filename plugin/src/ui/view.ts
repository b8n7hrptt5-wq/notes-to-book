import { App, FileSystemAdapter, ItemView, Notice, TFile, TFolder, WorkspaceLeaf, setIcon } from "obsidian";
import { assemble, buildCover, buildToc, type TocEntry } from "../core/assemble";
import type { ItemRole } from "../core/types";
import { Paginator } from "../core/paginate";
import { settingsFromTemplate, getTemplate, TEMPLATES } from "../core/templates";
import { buildCss } from "../core/css";
import { PAPERS, type BlockKind, type DocSettings, type ElemOpts, type PaginationResult, type ScopedRule, type SourceBlock } from "../core/types";
import { parseMarkdown } from "../core/markdown";
import { newProject, addItems, moveItem, retemplate, serialize, deserialize, type Project } from "../core/project";
import { verify, type VerifyReport } from "../core/verify";
import { extractPdf } from "../core/pdf-text";
import { ObsidianBlockRenderer } from "../adapters/obsidian-render";
import { exportPdf } from "../adapters/exporter";
import type NotesToBookPlugin from "../main";
import { ReportModal } from "./report";
import { applyRules } from "../core/rules";

export const VIEW_TYPE = "notes-to-book-view";

interface ViewState {
  project: Project;
  pages: number;
  chapters: number;
  selected?: { id: string; kind: BlockKind };
  busy: boolean;
}

export class LayoutView extends ItemView {
  private st: ViewState;
  private pageHostEl!: HTMLElement;
  private sideEl!: HTMLElement;
  private inspectEl!: HTMLElement;
  private statEl!: HTMLElement;
  private docEl: HTMLElement;
  private renderer: ObsidianBlockRenderer;
  private sources: SourceBlock[] = [];
  private result: PaginationResult | null = null;
  private toc: TocEntry[] = [];
  private zoom = 0.72;
  private styleEl: HTMLStyleElement;
  private lastReport: VerifyReport | null = null;
  /** 每次 relayout 递增；跑完时如果已经不是最新一版，结果就直接丢掉 */
  private gen = 0;
  /** 排版进行中又被要求排版：记下来，等这轮结束立刻再跑一次，不丢请求 */
  private rerun = false;

  constructor(leaf: WorkspaceLeaf, private plugin: NotesToBookPlugin) {
    super(leaf);
    this.docEl = document.createElement("div");
    this.renderer = new ObsidianBlockRenderer(this.app, this.docEl);
    this.styleEl = document.createElement("style");
    this.st = { project: plugin.getActiveProject(), pages: 0, chapters: 0, busy: false };
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "排版预览";
  }
  getIcon() {
    return "book-open";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("ntb-view");
    document.head.appendChild(this.styleEl);
    // 离屏容器必须真的挂在 DOM 上：Mermaid 与 MathJax 需要连着文档才渲染
    this.docEl.addClass("ntb-offscreen");
    root.appendChild(this.docEl);

    // 顶栏
    const bar = root.createDiv({ cls: "ntb-topbar" });
    const titleBox = bar.createDiv({ cls: "ntb-title" });
    const nameEl = titleBox.createEl("input", { cls: "ntb-name", type: "text" });
    nameEl.value = this.st.project.name;
    nameEl.addEventListener("change", () => {
      this.st.project.name = nameEl.value || "未命名";
      this.plugin.saveProject(this.st.project);
      this.renderSide();
    });

    const tplWrap = bar.createDiv({ cls: "ntb-tplwrap" });
    const sel = tplWrap.createEl("select", { cls: "dropdown" });
    for (const t of TEMPLATES) {
      const o = sel.createEl("option", { text: t.name, value: t.id });
      o.title = t.purpose;
    }
    sel.value = this.st.project.templateId;
    sel.addEventListener("change", () => {
      retemplate(this.st.project, sel.value);
      this.plugin.saveProject(this.st.project);
      void this.relayout();
    });

    const mkBtn = (icon: string, label: string, cb: () => void, cls = "ntb-btn") => {
      const b = bar.createEl("button", { cls });
      const i = b.createSpan({ cls: "ntb-ico" });
      setIcon(i, icon);
      b.createSpan({ text: label });
      b.addEventListener("click", cb);
      return b;
    };

    mkBtn("folder-plus", "选稿", () => this.plugin.openPicker(this));
    mkBtn("settings-2", "全文设置", () => {
      this.st.selected = undefined;
      this.renderInspect();
      this.outline();
    });
    mkBtn("check-check", "核对成品", () => void this.runVerify(), "ntb-btn");
    mkBtn("file-down", "导出 PDF", () => void this.runExport(), "ntb-btn mod-cta");

    this.statEl = bar.createDiv({ cls: "ntb-stat" });

    // 主体
    const main = root.createDiv({ cls: "ntb-main" });
    this.sideEl = main.createDiv({ cls: "ntb-side" });

    const stage = main.createDiv({ cls: "ntb-stage" });
    const zoomBar = stage.createDiv({ cls: "ntb-zoombar" });
    const zOut = zoomBar.createEl("button", { cls: "ntb-mini", text: "−" });
    const zIn = zoomBar.createEl("button", { cls: "ntb-mini", text: "+" });
    const zFit = zoomBar.createEl("button", { cls: "ntb-mini", text: "适宽" });
    zOut.addEventListener("click", () => this.setZoom(this.zoom - 0.08));
    zIn.addEventListener("click", () => this.setZoom(this.zoom + 0.08));
    zFit.addEventListener("click", () => {
      const w = this.pageHostEl.clientWidth - 40;
      const pw = PAPERS[this.st.project.settings.paper].w * (96 / 25.4);
      this.setZoom(Math.max(0.25, Math.min(1.4, w / pw)));
    });

    this.pageHostEl = stage.createDiv({ cls: "ntb-pagehost" });
    this.inspectEl = main.createDiv({ cls: "ntb-inspect" });

    this.pageHostEl.addEventListener("click", (ev) => this.onStageClick(ev));
    this.setZoom(this.zoom);

    await this.relayout();
  }

  async onClose() {
    this.styleEl.remove();
    this.renderer.dispose();
  }

  // ---------- 数据 ----------

  setProject(p: Project) {
    this.st.project = p;
    void this.relayout();
    this.renderSide();
  }

  get project() {
    return this.st.project;
  }

  private async loadContents(): Promise<{ path: string; role: ItemRole; md: string; missing?: boolean }[]> {
    const out: { path: string; role: ItemRole; md: string; missing?: boolean }[] = [];
    for (const it of this.st.project.items) {
      let file = this.app.vault.getAbstractFileByPath(it.path);
      if (!(file instanceof TFile)) {
        const base = it.path.split("/").pop() ?? "";
        const cand = this.app.vault.getMarkdownFiles().find((f) => f.name === base && f.path !== it.path);
        if (cand) {
          it.path = cand.path;
          file = cand;
          new Notice(`已重新定位：${cand.path}`);
          this.plugin.saveProject(this.st.project);
        }
      }
      if (!(file instanceof TFile)) {
        out.push({ path: it.path, role: it.role, md: "", missing: true });
        continue;
      }
      out.push({ path: file.path, role: it.role, md: await this.app.vault.cachedRead(file) });
    }
    return out;
  }

  /** 等字体与下一帧：量高度之前先把排版环境稳定下来 */
  private settle(): Promise<void> {
    const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
    const f = fonts?.ready ?? Promise.resolve();
    // 窗口不可见（最小化、被完全遮挡、切到别的桌面）时 requestAnimationFrame 根本不会回调，
    // 只等帧会把 busy 永远卡在 true 上，整个视图就死了。所以给帧加超时兜底：
    // 等不到帧也要往下走——隐藏窗口里的同步测量仍然是准的。
    const raf = new Promise<void>((resolve) => {
      let done = false;
      const fin = () => {
        if (done) return;
        done = true;
        resolve();
      };
      requestAnimationFrame(() => requestAnimationFrame(fin));
      window.setTimeout(fin, 120);
    });
    return Promise.all([f, raf]).then(() => undefined);
  }

  /** 等图片把真实尺寸算出来；公式与 Mermaid 由 prerender 里的 settle 负责 */
  private async settleMedia(blocks: HTMLElement[]): Promise<void> {
    const imgs: HTMLImageElement[] = [];
    for (const b of blocks) b.querySelectorAll("img").forEach((i) => imgs.push(i));
    if (!imgs.length) return;
    await Promise.all(
      imgs.map(
        (img) =>
          new Promise<void>((resolve) => {
            if (img.complete && img.naturalWidth > 0) return resolve();
            let done = false;
            const fin = () => {
              if (done) return;
              done = true;
              resolve();
            };
            img.addEventListener("load", fin, { once: true });
            img.addEventListener("error", fin, { once: true });
            window.setTimeout(fin, 4000);
          })
      )
    );
  }

  /** 有没有页面内容超出纸面（会被 overflow:hidden 裁掉，成品就是缺内容） */
  private pageOverflow(): boolean {
    const pages = this.pageHostEl.querySelectorAll(".ntb-page");
    for (const pg of Array.from(pages)) {
      const col = pg.querySelector<HTMLElement>(".ntb-col");
      if (col && col.scrollHeight - col.clientHeight > 2) return true;
    }
    return false;
  }

  private idleWaiters: Array<() => void> = [];

  /** 排版结束（正常结束、超时中断都算）：叫醒所有等空闲的调用者 */
  private markIdle() {
    this.st.busy = false;
    const w = this.idleWaiters;
    this.idleWaiters = [];
    for (const f of w) f();
  }

  /** 导出/核对之前先等排版彻底停下来（含等它把补排那一轮也跑完） */
  private async waitIdle(): Promise<void> {
    const t0 = Date.now();
    // 光等一次 markIdle 不够：叫醒等待者的同一拍里可能又启动了补排，
    // 导出正好撞上第二轮排版清空 DOM，克隆出来的就是上一版。
    while ((this.st.busy || this.rerun) && Date.now() - t0 < 90000) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        this.idleWaiters.push(resolve);
        window.setTimeout(resolve, 200);
      });
    }
  }

  async relayout() {
    if (this.st.busy) {
      // 上一轮还在跑（多半是在等字体/媒体）。直接丢弃会让用户刚改的模板或设置不生效，
      // 界面停在上一次的结果上。这里记账，等这轮结束再补一次。
      this.rerun = true;
      return;
    }
    this.st.busy = true;
    const gen = ++this.gen;
    // 兜底：万一某个 await 还是不回来，宁可放掉 busy 也不能让视图锁死。
    const watchdog = window.setTimeout(() => {
      if (this.st.busy && gen === this.gen) {
        this.st.busy = false;
        this.rerun = false;
        new Notice("排版超时，已中断。可再点一次重试。");
        this.markIdle();
      }
    }, 45000);
    try {
      const p = this.st.project;
      const tpl = getTemplate(p.templateId);
      const settings = p.settings;
      this.styleEl.textContent = buildCss(settings, tpl, ".ntb-view .ntb-pagehost");
      // 分页全靠量高度。字体没就位、样式还没落到布局上时量出来的行高是错的，
      // 表格会因为「看着能放下」而不被拆，等字体换了再把内容顶出页面，字就没了。
      // 先等字体和下一帧，再开始量。
      await this.settle();
      await this.settle();

      const items = await this.loadContents();
      const missing = items.filter((i) => i.missing);
      if (missing.length) {
        new Notice(`${missing.length} 篇笔记找不到，可在右侧「修」里重新指定。`);
      }
      const usable = items.filter((i) => !i.missing);

      for (const it of usable) {
        await this.renderer.prerender(it.path, parseMarkdown(it.md));
      }

      const assembled = assemble(
        usable.map((i) => ({ path: i.path, role: i.role, md: i.md })),
        settings,
        tpl,
        (b, path) => this.renderer.render(b, path),
        new Set(p.excludedBlocks),
        { resolveImage: (src, from) => this.resolveImage(src, from) }
      );
      applyRules(assembled.blocks, assembled.sources, p.rules);

      let tocBlocks: HTMLElement[] = [];
      let result: PaginationResult | null = null;
      let toc: TocEntry[] = [];
      let prev = -1;

      // 分页全靠量高度，而图片、公式、Mermaid 是异步落地的：第一次量的时候它们可能还没有尺寸，
      // 于是「看着放得下」，等真正打印时它们长出来，把内容顶出页面、被 overflow 裁掉。
      // 所以：排之前先把媒体等就位；排完再回首检查每页有没有溢出，有就补排一轮。
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.settleMedia(assembled.blocks);
        tocBlocks = [];
        toc = [];
        prev = -1;

        for (let iter = 0; iter < 5; iter++) {
          const all: HTMLElement[] = [];
          if (settings.cover.on) all.push(buildCover(settings));
          all.push(...tocBlocks);
          // 分页是破坏性的（跨页要拆块：表格切行、提示块切子元素）。
          // 目录页码要反复试排才能收敛，如果每轮都在同一批 DOM 上拆，
          // 上一轮切走的子元素就跟着被丢掉的续块一起消失了——正文会静悄悄地少内容。
          // 所以每轮都从干净的副本排。
          for (const b of assembled.blocks) all.push(b.cloneNode(true) as HTMLElement);

          const paginator = new Paginator(this.pageHostEl, { settings, template: tpl, sources: assembled.sources });
          result = paginator.layout(all);

          const entries: TocEntry[] = result.headings
            .filter((h) => h.level <= settings.toc.depth)
            .map((h) => ({ text: h.text, level: h.level, page: h.page, chapterIndex: h.chapterIndex }));

          const count = result.pages.length;
          if (settings.toc.on) {
            if (entries.length === toc.length && count === prev) break;
            toc = entries;
            tocBlocks = buildToc(entries, settings).blocks;
            prev = count;
          } else {
            toc = entries;
            break;
          }
        }

        // 排完回首看一遍：还有页面溢出，说明量的时候某个块没有真实尺寸（图/公式晚到），
        // 补排一轮；连着两轮都溢出，那就是内容本身放不下，交给警告提示。
        if (!this.pageOverflow()) break;
      }

      // 已经有一版更新的排版在跑了（比如 watchdog 放掉 busy 之后又点了一次），
      // 这版结果就是过期的，不能往界面上写。
      if (gen !== this.gen) return;

      this.sources = assembled.sources;
      this.result = result;
      this.toc = toc;
      this.st.pages = result?.pages.length ?? 0;
      this.st.chapters = assembled.chapters.length;

      this.statEl.setText(
        `${this.st.pages} 页 · ${this.st.chapters} 章 · ${usable.length} 篇` +
          (result?.warnings.length ? ` · ${result.warnings.length} 处提示` : "")
      );
      this.applyZoom();
      this.renderSide();
      this.renderInspect();
    } catch (e) {
      if (gen === this.gen) {
        console.error(e);
        new Notice(`排版失败：${(e as Error).message}`);
      }
    } finally {
      window.clearTimeout(watchdog);
      if (gen === this.gen) {
        this.markIdle();
        if (this.rerun) {
          this.rerun = false;
          void this.relayout();
        }
      }
    }
  }

  private setZoom(z: number) {
    this.zoom = Math.max(0.2, Math.min(1.6, z));
    this.applyZoom();
  }

  /** transform 不占位，套一层按缩放后尺寸占位的框，滚动条和居中才对 */
  private applyZoom() {
    const host = this.pageHostEl;
    if (!host) return;
    const paper = PAPERS[this.st.project.settings.paper];
    for (const page of Array.from(host.querySelectorAll<HTMLElement>(".ntb-page"))) {
      let wrap = page.parentElement;
      if (!wrap || !wrap.classList.contains("ntb-scaler")) {
        wrap = document.createElement("div");
        wrap.className = "ntb-scaler";
        page.replaceWith(wrap);
        wrap.appendChild(page);
      }
      wrap.style.width = `${paper.w * this.zoom}mm`;
      wrap.style.height = `${paper.h * this.zoom}mm`;
      page.style.transformOrigin = "top left";
      page.style.transform = `scale(${this.zoom})`;
    }
  }

  // ---------- 选稿面板 ----------

  renderSide() {
    if (!this.sideEl) return;
    this.sideEl.empty();
    const head = this.sideEl.createDiv({ cls: "ntb-side-head" });
    head.createSpan({ text: "选稿" });
    const add = head.createEl("button", { cls: "ntb-mini", text: "＋" });
    add.addEventListener("click", () => this.plugin.openPicker(this));

    const list = this.sideEl.createDiv({ cls: "ntb-items" });
    if (!this.st.project.items.length) {
      list.createDiv({ cls: "ntb-empty", text: "还没有选稿。点右上「选稿」加一篇笔记，或把 markdown 拖进来。" });
    }
    this.st.project.items.forEach((it, idx) => {
      const row = list.createDiv({ cls: "ntb-item" });
      row.draggable = true;
      row.dataset.index = String(idx);
      const drag = row.createSpan({ cls: "ntb-drag", text: "⋮⋮" });
      drag.title = "拖动排序";
      const nm = row.createDiv({ cls: "ntb-item-name" });
      nm.setText((it.title || it.path.split("/").pop() || "").replace(/\.md$/, ""));
      nm.title = it.path;
      const role = row.createEl("button", {
        cls: "ntb-role",
        text: it.role === "chapter" ? "章" : "节",
      });
      role.title = "点一下切换：章＝另起一页，节＝接排";
      role.addEventListener("click", () => {
        it.role = it.role === "chapter" ? "section" : "chapter";
        this.plugin.saveProject(this.st.project);
        void this.relayout();
      });
      const del = row.createEl("button", { cls: "ntb-mini", text: "×" });
      del.addEventListener("click", () => {
        this.st.project.items.splice(idx, 1);
        this.plugin.saveProject(this.st.project);
        void this.relayout();
      });
      row.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData("text/plain", String(idx));
      });
      row.addEventListener("dragover", (e) => e.preventDefault());
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer?.getData("text/plain"));
        moveItem(this.st.project, from, idx);
        this.plugin.saveProject(this.st.project);
        void this.relayout();
      });
    });

    if (this.result?.warnings.length) {
      const warn = this.sideEl.createDiv({ cls: "ntb-warnbox" });
      warn.createDiv({ cls: "ntb-warn-title", text: `排版提示 ${this.result.warnings.length}` });
      this.result.warnings.slice(0, 6).forEach((w) => {
        const r = warn.createDiv({ cls: "ntb-warn-row" });
        r.setText(w.detail);
        if (w.page) r.createSpan({ cls: "ntb-warn-pg", text: `P${w.page}` });
      });
    }
  }

  // ---------- 检查器 ----------

  private renderInspect() {
    if (!this.inspectEl) return;
    this.inspectEl.empty();
    const sel = this.st.selected;
    if (sel) {
      this.renderElementPanel(sel);
      return;
    }
    this.renderDocPanel();
  }

  private renderDocPanel() {
    const box = this.inspectEl.createDiv({ cls: "ntb-panel" });
    box.createDiv({ cls: "ntb-panel-title", text: "全文设置" });
    const s = this.st.project.settings;
    const touch = () => {
      this.plugin.saveProject(this.st.project);
      void this.relayout();
    };

    const row = (label: string, node: HTMLElement) => {
      const r = box.createDiv({ cls: "ntb-row" });
      r.createSpan({ cls: "ntb-row-label", text: label });
      r.appendChild(node);
    };

    const paperSel = box.createEl("select", { cls: "dropdown" });
    for (const p of Object.values(PAPERS)) paperSel.createEl("option", { text: `${p.name} ${p.w}×${p.h}mm`, value: p.id });
    paperSel.value = s.paper;
    paperSel.addEventListener("change", () => {
      s.paper = paperSel.value as DocSettings["paper"];
      touch();
    });
    row("纸张", paperSel);

    const num = (v: number, min: number, max: number, step: number, on: (v: number) => void): HTMLElement => {
      const wrap = document.createElement("span");
      const range = document.createElement("input");
      range.type = "range";
      range.min = String(min);
      range.max = String(max);
      range.step = String(step);
      range.value = String(v);
      const out = document.createElement("span");
      out.className = "ntb-num";
      out.textContent = String(v);
      range.addEventListener("input", () => {
        out.textContent = range.value;
        on(Number(range.value));
      });
      range.addEventListener("change", touch);
      wrap.append(range, out);
      return wrap;
    };

    row("字号 pt", num(s.typo.fontSize, 7, 16, 0.5, (v) => (s.typo.fontSize = v)));
    row("行距", num(s.typo.lineHeight, 1.2, 2.4, 0.05, (v) => (s.typo.lineHeight = v)));
    row("首行缩进 字", num(s.typo.paraIndent, 0, 3, 0.5, (v) => (s.typo.paraIndent = v)));
    row("栏数", num(s.columns, 1, 2, 1, (v) => (s.columns = v)));
    row("装订边 mm", num(s.gutter, 0, 12, 1, (v) => (s.gutter = v)));

    const margins = box.createDiv({ cls: "ntb-grid" });
    (["top", "right", "bottom", "left"] as const).forEach((k) => {
      const cell = margins.createDiv({ cls: "ntb-cell" });
      cell.createSpan({ text: { top: "上", right: "右", bottom: "下", left: "左" }[k] });
      const inp = cell.createEl("input", { type: "number" });
      inp.value = String(s.margins[k]);
      inp.addEventListener("change", () => {
        s.margins[k] = Number(inp.value) || 0;
        touch();
      });
    });

    const toggles = box.createDiv({ cls: "ntb-toggles" });
    const toggle = (label: string, on: boolean, cb: (v: boolean) => void) => {
      const b = toggles.createEl("button", { cls: `ntb-toggle ${on ? "on" : ""}`, text: label });
      b.addEventListener("click", () => {
        cb(!on);
        touch();
      });
    };
    toggle("封面", s.cover.on, (v) => (s.cover.on = v));
    toggle("目录", s.toc.on, (v) => (s.toc.on = v));
    toggle("页眉", s.furniture.headerOn, (v) => (s.furniture.headerOn = v));
    toggle("页脚页码", s.furniture.footerOn, (v) => (s.furniture.footerOn = v));
    toggle("章另起页", s.chapter.ownPage, (v) => (s.chapter.ownPage = v));
    toggle("双面镜像", s.mirror, (v) => (s.mirror = v));

    if (s.cover.on) {
      const cv = box.createDiv({ cls: "ntb-sub" });
      cv.createDiv({ cls: "ntb-sub-title", text: "封面" });
      const t = cv.createEl("input", { type: "text", placeholder: "书名" });
      t.value = s.cover.title;
      t.addEventListener("change", () => {
        s.cover.title = t.value;
        touch();
      });
      const st = cv.createEl("input", { type: "text", placeholder: "副标题" });
      st.value = s.cover.subtitle;
      st.addEventListener("change", () => {
        s.cover.subtitle = st.value;
        touch();
      });
      const au = cv.createEl("input", { type: "text", placeholder: "作者/单位" });
      au.value = s.cover.author;
      au.addEventListener("change", () => {
        s.cover.author = au.value;
        touch();
      });
      const dt = cv.createEl("input", { type: "text", placeholder: "日期" });
      dt.value = s.cover.date;
      dt.addEventListener("change", () => {
        s.cover.date = dt.value;
        touch();
      });
    }

    if (s.toc.on) {
      const tc = box.createDiv({ cls: "ntb-sub" });
      tc.createDiv({ cls: "ntb-sub-title", text: "目录" });
      const d = tc.createEl("select", { cls: "dropdown" });
      [1, 2, 3].forEach((n) => d.createEl("option", { text: `${n} 级`, value: String(n) }));
      d.value = String(s.toc.depth);
      d.addEventListener("change", () => {
        s.toc.depth = Number(d.value);
        touch();
      });
    }

    const hint = box.createDiv({ cls: "ntb-hint" });
    hint.setText("点预览里的表格、代码或图片，可以只改那一个元素。");
  }

  private renderElementPanel(sel: { id: string; kind: BlockKind }) {
    const box = this.inspectEl.createDiv({ cls: "ntb-panel" });
    const src = this.sources.find((s) => s.id === sel.id);
    box.createDiv({ cls: "ntb-panel-title", text: KIND_LABEL[sel.kind] ?? "元素" });
    if (src) {
      const meta = box.createDiv({ cls: "ntb-meta" });
      meta.setText(`${src.srcPath.split("/").pop()} · 第 ${src.srcLine} 行`);
      meta.title = src.srcPath;
      const teaser = box.createDiv({ cls: "ntb-teaser" });
      teaser.setText(src.text.slice(0, 120) || "（无文本）");
    }
    const page = this.result?.placed.find((p) => p.id === sel.id)?.page;
    if (page) box.createDiv({ cls: "ntb-meta", text: `成品第 ${page} 页` });

    const opts = box.createDiv({ cls: "ntb-opts" });
    const chIndex = src?.chapterIndex ?? 0;
    const optToggle = (label: string, key: keyof ElemOpts) => {
      const b = opts.createEl("button", { cls: "ntb-toggle", text: label });
      b.addEventListener("click", () => {
        b.toggleClass("on", true);
        this.applyScoped(sel.kind, { [key]: true } as ElemOpts, chIndex);
      });
    };
    const optSize = (label: string, value: number) => {
      const r = opts.createDiv({ cls: "ntb-row" });
      r.createSpan({ cls: "ntb-row-label", text: label });
      const inp = r.createEl("input", { type: "number" });
      inp.value = String(value);
      inp.style.width = "64px";
      const b = r.createEl("button", { cls: "ntb-mini", text: "应用" });
      b.addEventListener("click", () => this.applyScoped(sel.kind, { fontSize: Number(inp.value) }, chIndex));
    };

    if (sel.kind === "table") {
      optToggle("跨页重复表头", "repeatHeader");
      optToggle("这一页改横向", "rotate");
      optToggle("整块另起页", "breakBefore");
      optSize("字号 pt", 9);
    } else if (sel.kind === "code") {
      optToggle("不自动换行", "wrap");
      optToggle("整块另起页", "breakBefore");
      optSize("字号 pt", 8.5);
    } else if (sel.kind === "image") {
      optToggle("整块另起页", "breakBefore");
      optSize("最大高度 %", 80);
    } else if (sel.kind === "heading") {
      optToggle("另起页", "breakBefore");
      optToggle("与下段同页", "keepWithNext");
    } else {
      optToggle("整块另起页", "breakBefore");
      optToggle("这一段不要", "hide");
    }

    const scope = box.createDiv({ cls: "ntb-scope" });
    scope.createDiv({ cls: "ntb-sub-title", text: "应用范围" });
    const mk = (label: string, s: ScopedRule["scope"]) => {
      const b = scope.createEl("button", { cls: "ntb-scope-btn", text: label });
      b.addEventListener("click", () => {
        this.applyScoped(sel.kind, this.pendingOpts ?? {}, chIndex, s);
      });
    };
    mk("只改这一处", "block");
    mk("本章同类都改", "chapter");
    mk("全稿同类都改", "doc");

    const rulesBox = box.createDiv({ cls: "ntb-rules" });
    if (this.st.project.rules.length) {
      rulesBox.createDiv({ cls: "ntb-sub-title", text: `已加规则 ${this.st.project.rules.length}` });
      this.st.project.rules.forEach((r, i) => {
        const rr = rulesBox.createDiv({ cls: "ntb-rule-row" });
        const scopeText = r.scope === "block" ? "此元素" : r.scope === "chapter" ? `第 ${r.chapterIndex} 章` : "全稿";
        rr.setText(`${scopeText} · ${r.types.map((t) => KIND_LABEL[t] ?? t).join("/")} · ${JSON.stringify(r.opts)}`);
        const x = rr.createEl("button", { cls: "ntb-mini", text: "×" });
        x.addEventListener("click", () => {
          this.st.project.rules.splice(i, 1);
          this.plugin.saveProject(this.st.project);
          void this.relayout();
        });
      });
    }
  }

  private pendingOpts: ElemOpts | null = null;

  private applyScoped(kind: BlockKind, opts: ElemOpts, chapterIndex: number, scope: ScopedRule["scope"] = "block") {
    const p = this.st.project;
    const rule: ScopedRule = {
      scope,
      chapterIndex,
      blockId: scope === "block" ? this.st.selected?.id : undefined,
      types: [kind],
      opts: { ...opts },
    };
    p.rules.push(rule);
    this.plugin.saveProject(p);
    void this.relayout();
  }

  private onStageClick(ev: MouseEvent) {
    const target = ev.target as HTMLElement;
    const block = target.closest<HTMLElement>("[data-ntb-id]");
    this.pageHostEl.querySelectorAll(".ntb-selected").forEach((e) => e.classList.remove("ntb-selected"));
    if (!block) {
      this.st.selected = undefined;
      this.renderInspect();
      return;
    }
    block.classList.add("ntb-selected");
    this.st.selected = { id: block.dataset.ntbId!, kind: (block.dataset.ntbKind as BlockKind) ?? "unknown" };
    this.renderInspect();
  }

  private outline() {
    this.pageHostEl.querySelectorAll(".ntb-selected").forEach((e) => e.classList.remove("ntb-selected"));
  }

  // ---------- 导出与核对 ----------

  async runExport(opts: { mutate?: (root: HTMLElement) => void; filename?: string } = {}) {
    await this.waitIdle();
    const p = this.st.project;
    const dir = this.plugin.settings.outputDir || "笔记成书";
    const base = (this.app.vault.adapter as FileSystemAdapter).getBasePath?.() ?? "";
    const target = `${base}/${dir}/${opts.filename ?? p.name}.pdf`;
    try {
      const fs = (window as unknown as { require: (m: string) => unknown }).require("fs") as typeof import("fs");
      fs.mkdirSync(`${base}/${dir}`, { recursive: true });
      const res = await exportPdf(this.pageHostEl, {
        filePath: target,
        settings: p.settings,
        template: getTemplate(p.templateId),
        open: opts.mutate ? false : this.plugin.settings.openAfterExport,
        mutate: opts.mutate,
      });
      if (!res.ok) {
        new Notice(res.error ?? "导出失败");
        return;
      }
      new Notice(`已导出：${dir}/${opts.filename ?? p.name}.pdf`);
      await this.verifyFile(target);
    } catch (e) {
      new Notice(`导出失败：${(e as Error).message}`);
    }
  }

  /** 核对功能自测：导出时故意删掉跨页表最后一行，看报告能不能指出来 */
  async exportWithDroppedRow() {
    const mutate = (root: HTMLElement) => {
      const conts = root.querySelectorAll<HTMLElement>(".ntb-table-wrap[data-ntb-cont='1']");
      const target = conts[conts.length - 1];
      const body = target?.querySelector("tbody");
      if (body && body.rows.length > 1) body.deleteRow(body.rows.length - 1);
    };
    await this.runExport({ mutate, filename: `${this.st.project.name}-漏行测试` });
  }

  async runVerify() {
    await this.waitIdle();
    const p = this.st.project;
    const dir = this.plugin.settings.outputDir || "笔记成书";
    const base = (this.app.vault.adapter as FileSystemAdapter).getBasePath?.() ?? "";
    const target = `${base}/${dir}/${p.name}.pdf`;
    const fs = (window as unknown as { require: (m: string) => unknown }).require("fs") as typeof import("fs");
    if (!fs.existsSync(target)) {
      new Notice("还没有导出过。先点「导出 PDF」，导出后会自动核对。");
      return;
    }
    await this.verifyFile(target);
  }

  private async verifyFile(target: string) {
    if (!this.result) return;
    const fs = (window as unknown as { require: (m: string) => typeof import("fs") }).require("fs") as typeof import("fs");
    const buf = fs.readFileSync(target);
    const digest = extractPdf(new Uint8Array(buf));
    // 目录可能独占一页，也可能接在第一页正文前（toc.ownPage 关掉时），
    // 所以先看有没有 toc 页，没有就按目录块实际落在哪一页来算
    const ownTocPages = this.result.pages.filter((p) => p.kind === "toc").map((p) => p.index);
    const placedTocPages = [
      ...new Set(this.result.placed.filter((p) => p.id.startsWith("toc#")).map((p) => p.page)),
    ].sort((a, b) => a - b);
    const tocPages = ownTocPages.length ? ownTocPages : placedTocPages;
    const report = verify(digest, this.sources, this.result, {
      pdfPath: target,
      toc: this.toc.map((e) => ({ entry: e, text: e.text })),
      tocPages,
    });
    this.lastReport = report;
    new ReportModal(this.app, report, this.sources, () => this.gotoPage(1)).open();
  }

  gotoPage(n: number) {
    const page = this.pageHostEl.querySelector<HTMLElement>(`.ntb-page[data-page="${n}"]`);
    page?.scrollIntoView({ behavior: "smooth", block: "start" });
    this.pageHostEl.querySelectorAll(".ntb-page").forEach((p) => p.classList.remove("ntb-flash"));
    page?.classList.add("ntb-flash");
  }

  get report() {
    return this.lastReport;
  }

  async saveToVault(file: TFile) {
    await this.app.vault.modify(file, serialize(this.st.project));
  }

  loadFrom(text: string) {
    this.st.project = deserialize(text);
    void this.relayout();
    this.renderSide();
  }

  projectSnapshot(): string {
    return serialize(this.st.project);
  }

  /** 把笔记里的图片引用解析成 Obsidian 的资源地址 */
  private resolveImage(src: string, from: string): string {
    const clean = src.replace(/^<|>$/g, "").split("|")[0].trim();
    const dest = this.app.metadataCache.getFirstLinkpathDest(clean, from);
    if (dest) return this.app.vault.adapter.getResourcePath(dest.path);
    return clean;
  }

  addNotes(items: { path: string; md: string }[]) {
    addItems(this.st.project, items);
    this.plugin.saveProject(this.st.project);
    void this.relayout();
  }
}

const KIND_LABEL: Record<string, string> = {
  heading: "标题",
  para: "段落",
  list: "列表",
  table: "表格",
  code: "代码块",
  image: "图片",
  quote: "引用",
  callout: "提示块",
  math: "公式",
  mermaid: "图表",
  hr: "分隔线",
  unknown: "其他",
  cover: "封面",
  toc: "目录",
  chapter: "章首页",
};

export { KIND_LABEL };
