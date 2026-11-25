import { App, Modal, TFile, TFolder, Notice } from "obsidian";
import type { LayoutView } from "./view";

/** 选稿：从库里挑笔记或整个文件夹 */
export class PickerModal extends Modal {
  private query = "";
  private listEl!: HTMLElement;
  private chosen = new Set<string>();

  constructor(app: App, private view: LayoutView, private onDone?: () => void) {
    super(app);
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("选稿");
    contentEl.addClass("ntb-picker");

    const bar = contentEl.createDiv({ cls: "ntb-pick-bar" });
    const input = bar.createEl("input", {
      type: "search",
      placeholder: "搜笔记名，或输入 / 看文件夹",
    });
    input.addEventListener("input", () => {
      this.query = input.value.trim();
      this.renderList();
    });
    input.focus();

    this.listEl = contentEl.createDiv({ cls: "ntb-pick-list" });
    this.renderList();

    const foot = contentEl.createDiv({ cls: "ntb-pick-foot" });
    foot.createSpan({ cls: "ntb-meta", text: "选中的笔记按库里顺序进入书稿，之后可拖动排序。" });
    const ok = foot.createEl("button", { cls: "mod-cta", text: "加入" });
    ok.addEventListener("click", () => {
      if (!this.chosen.size) {
        new Notice("还没选。");
        return;
      }
      const files = [...this.chosen]
        .map((p) => this.app.vault.getAbstractFileByPath(p))
        .filter((f): f is TFile => f instanceof TFile);
      this.addFiles(files);
    });
  }

  private async addFiles(files: TFile[]) {
    const payload: { path: string; md: string }[] = [];
    for (const f of files) payload.push({ path: f.path, md: await this.app.vault.cachedRead(f) });
    this.view.addNotes(payload);
    this.close();
    this.onDone?.();
  }

  private renderList() {
    this.listEl.empty();
    const files = this.app.vault.getMarkdownFiles().filter((f) => {
      if (!this.query) return true;
      return f.path.toLowerCase().includes(this.query.toLowerCase());
    });

    // 文件夹块：整夹加入
    if (!this.query || this.query.startsWith("/")) {
      const folders = this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder);
      const relevant = folders.filter((f) => f.path !== "/" && (!this.query || f.path.toLowerCase().includes(this.query.slice(1).toLowerCase())));
      relevant.slice(0, 12).forEach((folder) => {
        const row = this.listEl.createDiv({ cls: "ntb-pick-row folder" });
        row.createSpan({ cls: "ntb-pick-name", text: `📁 ${folder.path}` });
        const n = folder.children.filter((c) => c instanceof TFile && c.extension === "md").length;
        row.createSpan({ cls: "ntb-meta", text: `${n} 篇` });
        if (n) {
          const b = row.createEl("button", { cls: "ntb-mini", text: "整夹加入" });
          b.addEventListener("click", async () => {
            const inner = collectMd(folder);
            if (!inner.length) return;
            await this.addFiles(inner);
          });
        }
      });
    }

    files.slice(0, 200).forEach((f) => {
      const row = this.listEl.createDiv({ cls: "ntb-pick-row" });
      const cb = row.createEl("input", { type: "checkbox" }) as HTMLInputElement;
      cb.checked = this.chosen.has(f.path);
      cb.addEventListener("change", () => {
        if (cb.checked) this.chosen.add(f.path);
        else this.chosen.delete(f.path);
      });
      const name = row.createSpan({ cls: "ntb-pick-name", text: f.basename });
      name.title = f.path;
      row.createSpan({ cls: "ntb-meta", text: f.parent?.path ?? "" });
      row.addEventListener("dblclick", async () => {
        await this.addFiles([f]);
      });
    });

    if (!files.length) this.listEl.createDiv({ cls: "ntb-empty", text: "没有匹配的笔记。" });
  }

  onClose() {
    this.contentEl.empty();
  }
}

function collectMd(folder: TFolder): TFile[] {
  const out: TFile[] = [];
  for (const c of folder.children) {
    if (c instanceof TFile && c.extension === "md") out.push(c);
    else if (c instanceof TFolder) out.push(...collectMd(c));
  }
  return out.sort((a, b) => a.path.localeCompare(b.path, "zh"));
}
