import { App, Modal } from "obsidian";
import type { SourceBlock } from "../core/types";
import type { VerifyReport } from "../core/verify";

export class ReportModal extends Modal {
  private filter: "all" | "missing" | "manual" | "mismatch" = "all";

  constructor(
    app: App,
    private report: VerifyReport,
    private sources: SourceBlock[],
    private onJump: (page: number) => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("导出后核对");
    contentEl.addClass("ntb-report");

    const r = this.report;
    const head = contentEl.createDiv({ cls: "ntb-rep-head" });
    const verdict = head.createDiv({
      cls: `ntb-verdict ${r.failed ? "bad" : "good"}`,
      text: r.failed ? "发现问题" : "通过",
    });
    void verdict;
    head.createDiv({
      cls: "ntb-rep-sum",
      text: `成品 ${r.pdfPages} 页 · 排版 ${r.layoutPages} 页 · 已核实 ${r.counts.ok} · 缺失 ${r.counts.missing} · 页码不符 ${r.counts.mismatch} · 需人工 ${r.counts.manual}`,
    });

    const fileLine = contentEl.createDiv({ cls: "ntb-rep-file" });
    fileLine.setText(r.pdfPath);

    // 过滤器
    const tabs = contentEl.createDiv({ cls: "ntb-rep-tabs" });
    const mk = (key: typeof this.filter, label: string, n: number) => {
      const b = tabs.createEl("button", { cls: `ntb-tab ${this.filter === key ? "on" : ""}`, text: `${label} ${n}` });
      b.addEventListener("click", () => {
        this.filter = key;
        this.renderRows();
        tabs.querySelectorAll(".ntb-tab").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
      });
    };
    mk("all", "全部", r.rows.length);
    mk("missing", "发现缺失", r.counts.missing);
    mk("mismatch", "页码不符", r.counts.mismatch);
    mk("manual", "需人工确认", r.counts.manual);

    this.rowsEl = contentEl.createDiv({ cls: "ntb-rep-rows" });
    this.renderRows();

    if (r.issues.length) {
      const iss = contentEl.createDiv({ cls: "ntb-rep-issues" });
      iss.createDiv({ cls: "ntb-sub-title", text: `问题 ${r.issues.length}` });
      r.issues.slice(0, 40).forEach((i) => {
        const row = iss.createDiv({ cls: "ntb-issue" });
        const tag = row.createSpan({ cls: `ntb-issue-tag ${i.kind}`, text: ISSUE_LABEL[i.kind] ?? i.kind });
        void tag;
        const body = row.createDiv({ cls: "ntb-issue-body" });
        body.createDiv({ cls: "ntb-issue-detail", text: i.detail });
        const loc = [i.srcPath, i.srcLine ? `第 ${i.srcLine} 行` : "", i.page ? `成品 P${i.page}` : ""]
          .filter(Boolean)
          .join(" · ");
        if (loc) body.createDiv({ cls: "ntb-meta", text: loc });
        if (i.sourceText || i.pdfText) {
          const pair = body.createDiv({ cls: "ntb-pair" });
          const left = pair.createDiv({ cls: "ntb-pair-col" });
          left.createDiv({ cls: "ntb-pair-title", text: "原稿" });
          left.createDiv({ cls: "ntb-pair-body", text: i.sourceText ?? "（无）" });
          const right = pair.createDiv({ cls: "ntb-pair-col" });
          right.createDiv({ cls: "ntb-pair-title", text: "成品该页实际文字" });
          right.createDiv({ cls: "ntb-pair-body", text: (i.pdfText ?? "").slice(0, 600) || "（该页没有可提取的文字）" });
        }
        if (i.page) {
          const go = body.createEl("button", { cls: "ntb-mini", text: "在预览里看这一页" });
          go.addEventListener("click", () => {
            this.onJump(i.page!);
            this.close();
          });
        }
      });
    }

    const foot = contentEl.createDiv({ cls: "ntb-rep-foot" });
    foot.setText(
      "核对只看文字是否进得去、页码对不对；图片、公式和图表按能否检出判断，检不出的标为需人工确认。"
    );
  }

  private rowsEl!: HTMLElement;

  private renderRows() {
    if (!this.rowsEl) return;
    this.rowsEl.empty();
    const list = this.report.rows.filter((r) => this.filter === "all" || r.status === this.filter);
    if (!list.length) {
      this.rowsEl.createDiv({ cls: "ntb-empty", text: "这一类没有条目。" });
      return;
    }
    const table = this.rowsEl.createEl("table", { cls: "ntb-rep-table" });
    const thead = table.createEl("thead");
    const tr = thead.createEl("tr");
    ["类型", "内容", "源位置", "页", "结论"].forEach((h) => tr.createEl("th", { text: h }));
    const tbody = table.createEl("tbody");
    list.slice(0, 400).forEach((r) => {
      const row = tbody.createEl("tr", { cls: `st-${r.status}` });
      row.createEl("td", { text: r.category });
      row.createEl("td", { text: r.label });
      const loc = row.createEl("td", { text: r.srcPath ? `${r.srcPath.split("/").pop()}:${r.srcLine}` : "—" });
      loc.title = r.srcPath;
      row.createEl("td", { text: r.page ? String(r.page) : "—" });
      const st = row.createEl("td", { text: STATUS_LABEL[r.status] + (r.note ? ` · ${r.note}` : "") });
      if (r.page) {
        st.addClass("ntb-clickable");
        st.addEventListener("click", () => {
          this.onJump(r.page!);
          this.close();
        });
      }
    });
    if (list.length > 400) {
      this.rowsEl.createDiv({ cls: "ntb-meta", text: `只显示前 400 条，共 ${list.length} 条` });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

const STATUS_LABEL: Record<string, string> = {
  ok: "已核实",
  missing: "发现缺失",
  manual: "需人工确认",
  mismatch: "页码不符",
};

const ISSUE_LABEL: Record<string, string> = {
  missing: "缺失",
  blank_page: "空白页",
  "blank-page": "空白页",
  "toc-page": "目录页码",
  clipped: "被裁切",
  "wide-table": "宽表",
  "long-code": "长代码",
  "missing-image": "图片",
  link: "链接",
};
