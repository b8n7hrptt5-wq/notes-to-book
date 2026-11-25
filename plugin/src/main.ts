import {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  MarkdownView,
} from "obsidian";
import { LayoutView, VIEW_TYPE } from "./ui/view";
import { PickerModal } from "./ui/picker";
import { newProject, type Project } from "./core/project";

interface PluginSettings {
  outputDir: string;
  openAfterExport: boolean;
  lastProjectId?: string;
  projects: Record<string, Project>;
}

const DEFAULTS: PluginSettings = {
  outputDir: "笔记成书",
  openAfterExport: true,
  projects: {},
};

export default class NotesToBookPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULTS };

  async onload() {
    const loaded = (await this.loadData()) as Partial<PluginSettings> | null;
    this.settings = { ...DEFAULTS, ...(loaded ?? {}) };
    this.settings.projects = this.settings.projects ?? {};

    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new LayoutView(leaf, this));

    this.addRibbonIcon("book-open", "排版并导出", () => void this.openForActiveFile());

    this.addCommand({
      id: "layout-current-note",
      name: "排版当前笔记",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "md") return false;
        if (!checking) void this.openForFile(file);
        return true;
      },
    });

    this.addCommand({
      id: "selftest-dropped-row",
      name: "自测：导出时故意漏掉跨页表末行（验证核对报告）",
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
        if (!leaf) return false;
        if (!checking) void (leaf.view as LayoutView).exportWithDroppedRow();
        return true;
      },
    });

    this.addCommand({
      id: "open-layout-window",
      name: "打开排版窗口",
      callback: () => void this.activate(),
    });

    this.addCommand({
      id: "layout-selection",
      name: "把当前笔记加入排版",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const file = view?.file;
        if (!file) return false;
        if (!checking) void this.addToLayout(file);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("排版并导出")
            .setIcon("book-open")
            .onClick(() => void this.openForFile(file))
        );
        menu.addItem((item) =>
          item
            .setTitle("加入当前书稿")
            .setIcon("plus")
            .onClick(() => void this.addToLayout(file))
        );
      })
    );

    this.addSettingTab(new NtbSettingTab(this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  // ---------- 项目 ----------

  getActiveProject(): Project {
    const id = this.settings.lastProjectId;
    if (id && this.settings.projects[id]) return this.settings.projects[id];
    const p = newProject("未命名书稿");
    this.settings.projects[p.id] = p;
    this.settings.lastProjectId = p.id;
    void this.saveData(this.settings);
    return p;
  }

  saveProject(p: Project) {
    p.updatedAt = Date.now();
    this.settings.projects[p.id] = p;
    this.settings.lastProjectId = p.id;
    void this.saveData(this.settings);
  }

  // ---------- 打开视图 ----------

  private async ensureView(): Promise<LayoutView> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    let leaf: WorkspaceLeaf;
    if (existing.length) {
      leaf = existing[0];
    } else {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view as LayoutView;
    view.setProject(this.getActiveProject());
    return view;
  }

  async activate() {
    await this.ensureView();
  }

  async openPicker(view: LayoutView) {
    new PickerModal(this.app, view).open();
  }

  async openForFile(file: TFile) {
    const md = await this.app.vault.cachedRead(file);
    const p = newProject(file.basename);
    p.settings.cover.title = file.basename;
    p.settings.cover.on = p.settings.cover.on;
    p.items = [{ path: file.path, role: "chapter", fingerprint: "" }];
    this.settings.projects[p.id] = p;
    this.settings.lastProjectId = p.id;
    await this.saveData(this.settings);
    const view = await this.ensureView();
    view.setProject(p);
  }

  async openForActiveFile() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "md") {
      new Notice("先把光标放在一篇 markdown 笔记里，或右键笔记选「排版并导出」。");
      return;
    }
    await this.openForFile(file);
  }

  async addToLayout(file: TFile) {
    const md = await this.app.vault.cachedRead(file);
    const view = await this.ensureView();
    view.addNotes([{ path: file.path, md }]);
    new Notice(`已加入：${file.basename}`);
  }
}

class NtbSettingTab extends PluginSettingTab {
  constructor(private plugin: NotesToBookPlugin) {
    super(plugin.app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Notes to Book" });

    new Setting(containerEl)
      .setName("导出目录")
      .setDesc("相对笔记库根目录。PDF 会写到 <库>/<目录>/<书稿名>.pdf。")
      .addText((t) =>
        t.setValue(this.plugin.settings.outputDir).onChange(async (v) => {
          this.plugin.settings.outputDir = v.trim() || "笔记成书";
          await this.plugin.saveData(this.plugin.settings);
        })
      );

    new Setting(containerEl)
      .setName("导出后自动打开")
      .setDesc("交给系统默认的 PDF 阅读器打开。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.openAfterExport).onChange(async (v) => {
          this.plugin.settings.openAfterExport = v;
          await this.plugin.saveData(this.plugin.settings);
        })
      );

    const ids = Object.keys(this.plugin.settings.projects);
    containerEl.createEl("h3", { text: `已保存的书稿（${ids.length}）` });
    ids.forEach((id) => {
      const p = this.plugin.settings.projects[id];
      new Setting(containerEl)
        .setName(p.name)
        .setDesc(`${p.items.length} 篇 · 模板 ${p.templateId} · 更新于 ${new Date(p.updatedAt).toLocaleString()}`)
        .addButton((b) =>
          b.setButtonText("打开").onClick(async () => {
            const view = await this.plugin.activate();
            void view;
            this.plugin.settings.lastProjectId = id;
            await this.plugin.saveData(this.plugin.settings);
            const leaf = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
            (leaf.view as LayoutView).setProject(p);
          })
        )
        .addButton((b) =>
          b.setButtonText("删除").setWarning().onClick(async () => {
            delete this.plugin.settings.projects[id];
            await this.plugin.saveData(this.plugin.settings);
            this.display();
          })
        );
    });
  }
}
