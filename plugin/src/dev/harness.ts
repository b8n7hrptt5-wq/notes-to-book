import { assemble, buildCover, buildToc, type TocEntry } from "../core/assemble";
import { Paginator } from "../core/paginate";
import { settingsFromTemplate, getTemplate } from "../core/templates";
import { buildCss, buildPrintCss } from "../core/css";
import type { DocSettings, PaginationResult, SourceBlock } from "../core/types";
import { stackPrintPages } from "../core/print";
import { renderBlock } from "./mini-render";

interface Item {
  path: string;
  role: "chapter" | "section";
  title?: string;
  md: string;
}

export interface Payload {
  items: Item[];
  template: string;
  paper?: string;
  settingsPatch?: Record<string, unknown>;
  cover?: { on?: boolean; title?: string; subtitle?: string; author?: string; date?: string };
  toc?: { on?: boolean; depth?: number };
  simulate?: { dropLastRowOfSplitTable?: boolean; extraBlankPage?: boolean };
}

interface Prepared {
  settings: DocSettings;
  sources: SourceBlock[];
  result: PaginationResult;
  toc: TocEntry[];
  pages: number;
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== "object") return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof (base as any)?.[k] === "object") {
      out[k] = deepMerge((base as any)[k], v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

let lastPrepared: Prepared | null = null;

function styleInto(doc: Document, css: string, id: string) {
  let el = doc.getElementById(id) as HTMLStyleElement | null;
  if (!el) {
    el = doc.createElement("style");
    el.id = id;
    doc.head.appendChild(el);
  }
  el.textContent = css;
}

export function prepare(payload: Payload): Prepared {
  const tpl = getTemplate(payload.template);
  let settings = settingsFromTemplate(payload.template, (payload.paper as DocSettings["paper"]) || undefined);
  if (payload.cover) settings = deepMerge(settings, { cover: payload.cover });
  if (payload.toc) settings = deepMerge(settings, { toc: payload.toc });
  if (payload.settingsPatch) settings = deepMerge(settings, payload.settingsPatch);

  const root = document.getElementById("preview")!;
  styleInto(document, buildCss(settings, tpl, "#preview"), "ntb-css");
  styleInto(document, buildPrintCss(settings, "#print-root"), "ntb-print-css");

  const { blocks, sources } = assemble(payload.items, settings, tpl, (b) => renderBlock(b), new Set());

  let tocBlocks: HTMLElement[] = [];
  let result: PaginationResult | null = null;
  let tocEntries: TocEntry[] = [];
  let prevCount = -1;

  for (let iter = 0; iter < 5; iter++) {
    const all: HTMLElement[] = [];
    if (settings.cover.on) all.push(buildCover(settings));
    all.push(...tocBlocks);
    all.push(...blocks);

    const paginator = new Paginator(root, { settings, template: tpl, sources });
    result = paginator.layout(all);

    const entries: TocEntry[] = result.headings
      .filter((h) => h.level <= settings.toc.depth && h.level >= 1)
      .map((h) => ({ text: h.text, level: h.level, page: h.page, chapterIndex: h.chapterIndex }));

    const count = result.pages.length;
    if (settings.toc.on) {
      if (entries.length === tocEntries.length && count === prevCount) break;
      tocEntries = entries;
      const built = buildToc(entries, settings);
      tocBlocks = built.blocks;
      sources.push(built.source);
      prevCount = count;
    } else if (iter === 0) {
      tocEntries = entries;
      break;
    }
  }

  if (payload.simulate?.extraBlankPage) {
    const blank = document.createElement("div");
    blank.className = "ntb-page";
    blank.innerHTML = "<div class='ntb-area'></div>";
    root.appendChild(blank);
  }

  if (payload.simulate?.dropLastRowOfSplitTable) {
    const cont = root.querySelectorAll<HTMLElement>(".ntb-table-wrap[data-ntb-cont='1']");
    const target = cont[cont.length - 1];
    const body = target?.querySelector("tbody");
    if (body && body.rows.length > 1) body.deleteRow(body.rows.length - 1);
  }

  lastPrepared = { settings, sources, result: result!, toc: tocEntries, pages: root.querySelectorAll(".ntb-page").length };
  return lastPrepared;
}

export function preparePrint(): number {
  const src = document.getElementById("preview")!;
  let rootEl = document.getElementById("print-root");
  if (!rootEl) {
    rootEl = document.createElement("div");
    rootEl.id = "print-root";
    document.body.appendChild(rootEl);
  }
  rootEl.innerHTML = "";
  rootEl.className = "ntb-print-root";
  src.querySelectorAll(".ntb-page").forEach((p) => rootEl!.appendChild(p.cloneNode(true)));
  const n = stackPrintPages(rootEl, lastPrepared!.settings);
  return n;
}

export function summary() {
  if (!lastPrepared) return null;
  const { result, sources, pages, toc } = lastPrepared;
  return {
    pages,
    layoutPages: result.pages.length,
    warnings: result.warnings,
    placed: result.placed,
    headings: result.headings,
    toc,
    sources: sources.map((s) => ({ ...s, rows: s.rows ? s.rows.length : undefined })),
    sourceRows: sources.map((s) => s.rows ?? null),
  };
}

declare global {
  interface Window {
    NTB: {
      prepare: typeof prepare;
      preparePrint: typeof preparePrint;
      summary: typeof summary;
    };
  }
}

window.NTB = { prepare, preparePrint, summary };
