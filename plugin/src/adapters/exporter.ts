import { Notice, Platform } from "obsidian";
import type { DocSettings } from "../core/types";
import { buildCss, buildPrintCss } from "../core/css";
import type { Template } from "../core/templates";
import { stackPrintPages } from "../core/print";

interface ElectronIpc {
  send(channel: string, payload: unknown): void;
  once(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
}

function ipc(): ElectronIpc | null {
  try {
    // Obsidian 桌面端是 Electron，渲染进程里可以直接 require
    const req = (window as unknown as { require?: (m: string) => unknown }).require;
    const electron = req ? (req("electron") as { ipcRenderer?: ElectronIpc }) : undefined;
    return electron?.ipcRenderer ?? null;
  } catch {
    return null;
  }
}

export interface ExportOptions {
  filePath: string;
  settings: DocSettings;
  template: Template;
  /** 导出后自动打开 */
  open: boolean;
  /** 测试钩子：打印前改一下 DOM，用来验证核对能不能抓出问题 */
  mutate?: (root: HTMLElement) => void;
}

export interface ExportResult {
  ok: boolean;
  filePath: string;
  error?: string;
}

/**
 * 把预览里的 .ntb-page 克隆到打印根，交给 Obsidian 主进程的 printToPDF。
 * 预览与导出是同一份 DOM + 同一份 CSS，所以页数、断页位置必然一致。
 */
export async function exportPdf(
  pagesHost: HTMLElement,
  opts: ExportOptions
): Promise<ExportResult> {
  if (!Platform.isDesktopApp) {
    return { ok: false, filePath: opts.filePath, error: "移动端不支持直接导出 PDF，请在桌面端使用。" };
  }
  const ipcRenderer = ipc();
  if (!ipcRenderer) {
    return {
      ok: false,
      filePath: opts.filePath,
      error: "拿不到 Electron 打印接口。可以先用命令面板里的「导出为 PDF」打印当前预览。",
    };
  }

  const root = document.createElement("div");
  root.id = "ntb-print-root";
  // Obsidian 的打印样式只保留 body > .print，所以这两个类都要带
  root.className = "print ntb-print-root";
  const style = document.createElement("style");
  style.id = "ntb-print-style";
  style.textContent = `
${buildCss(opts.settings, opts.template, "#ntb-print-root")}
${buildPrintCss(opts.settings, "#ntb-print-root")}
@media print {
  html, body { background: #fff !important; }
  body > *:not(#ntb-print-root) { display: none !important; }
  #ntb-print-root { display: block !important; padding: 0 !important; margin: 0 !important; }
}
@media screen { #ntb-print-root { display: none !important; } }
`;
  document.head.appendChild(style);
  document.body.appendChild(root);

  const pages = Array.from(pagesHost.querySelectorAll<HTMLElement>(".ntb-page"));
  if ((window as any).__ntbDebug) {
    console.log("[export] host pages", pages.length);
    pages.forEach((p, i) => {
      const col = p.querySelector<HTMLElement>(".ntb-col");
      const kids = [...(col?.children ?? [])].map((e) => (e as HTMLElement).dataset.ntbId?.split("/").pop() + ((e as HTMLElement).dataset.ntbCont ? "~" : ""));
      console.log("[export p" + (i + 1) + "]", "kids", kids.length, kids.slice(0, 6).join(","));
    });
  }
  for (const p of pages) {
    const clone = p.cloneNode(true) as HTMLElement;
    clone.classList.add("ntb-page-print");
    root.appendChild(clone);
  }
  stackPrintPages(root, opts.settings);
  if ((window as any).__ntbDebug) {
    const ps = Array.from(root.querySelectorAll<HTMLElement>(".ntb-page"));
    ps.forEach((pg, i) => {
      const col = pg.querySelector<HTMLElement>(".ntb-col");
      const cs = col ? getComputedStyle(col) : null;
      console.log("[print p" + (i + 1) + "]", "colH", col?.clientHeight, "scrollH", col?.scrollHeight, "kids", col?.childElementCount, "font", cs?.fontFamily, cs?.fontSize, "w", col?.clientWidth);
    });
  }
  opts.mutate?.(root);

  const ip = ipcRenderer;
  const done = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      ip.removeListener("print-to-pdf", onDone);
      reject(new Error("打印超时（30 秒）。文件可能已生成，请检查目标目录。"));
    }, 30000);
    function onDone() {
      window.clearTimeout(timer);
      ip.removeListener("print-to-pdf", onDone);
      resolve();
    }
    ip.once("print-to-pdf", onDone);
  });

  try {
    ip.send("print-to-pdf", {
      filepath: opts.filePath,
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      open: opts.open,
    });
    await done;
    return { ok: true, filePath: opts.filePath };
  } catch (e) {
    return { ok: false, filePath: opts.filePath, error: (e as Error).message };
  } finally {
    root.remove();
    style.remove();
  }
}

/** 没有 Electron 打印时的退路：浏览器打印对话框（Chromium 里可以「另存为 PDF」） */
export function fallbackPrint(pagesHost: HTMLElement, settings: DocSettings, template: Template) {
  const root = document.createElement("div");
  root.id = "ntb-print-root";
  root.className = "print ntb-print-root";
  const style = document.createElement("style");
  style.textContent = `${buildCss(settings, template, "#ntb-print-root")}${buildPrintCss(settings, "#ntb-print-root")}
@media print { body > *:not(#ntb-print-root) { display: none !important; } }
@media screen { #ntb-print-root { display: none !important; } }`;
  document.head.appendChild(style);
  document.body.appendChild(root);
  pagesHost.querySelectorAll(".ntb-page").forEach((p) => root.appendChild(p.cloneNode(true)));
  stackPrintPages(root, settings);
  new Notice("已切换到打印视图，请在打印对话框里选择「另存为 PDF」。");
  window.print();
  window.setTimeout(() => {
    root.remove();
    style.remove();
  }, 1500);
}
