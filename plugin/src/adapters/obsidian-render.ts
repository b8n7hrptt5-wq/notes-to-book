import { App, Component, MarkdownRenderer } from "obsidian";
import type { MdBlock } from "../core/markdown";

/**
 * 用 Obsidian 自己的渲染器把 markdown 变成 DOM：
 * 双链、嵌入、Callout、公式、Mermaid、代码高亮都交给它，插件不重复造。
 */
export class ObsidianBlockRenderer {
  private cache = new Map<string, HTMLElement>();
  private component: Component;

  constructor(private app: App, private container: HTMLElement) {
    this.component = new Component();
    this.component.load();
  }

  dispose() {
    this.component.unload();
    this.cache.clear();
  }

  key(path: string, b: MdBlock): string {
    return `${path}@@${b.startLine}@@${b.raw.length}`;
  }

  async prerender(path: string, blocks: MdBlock[]): Promise<void> {
    for (const b of blocks) {
      const k = this.key(path, b);
      if (this.cache.has(k)) continue;
      const host = document.createElement("div");
      host.className = "ntb-md-host";
      this.container.appendChild(host);
      try {
        await MarkdownRenderer.render(this.app, b.raw, host, path, this.component);
      } catch {
        const p = document.createElement("p");
        p.textContent = b.raw;
        host.appendChild(p);
      }
      await this.settle(host);
      this.cache.set(k, host);
      host.detach();
    }
  }

  /** Mermaid 和 MathJax 都是异步渲染的，等它们落成 svg / mjx-container */
  private async settle(host: HTMLElement) {
    const needMermaid = !!host.querySelector(".mermaid, .block-language-mermaid");
    const needMath = !!(host.querySelector(".math") || host.querySelector("mjx-container"));
    if (!needMermaid && !needMath) return;
    const start = Date.now();
    while (Date.now() - start < 1500) {
      const mermaidOk = !needMermaid || !!host.querySelector(".mermaid svg, .block-language-mermaid svg, svg");
      const mathOk = !needMath || !!host.querySelector("mjx-container");
      if (mermaidOk && mathOk) return;
      await new Promise((r) => window.setTimeout(r, 60));
    }
  }

  render(b: MdBlock, path: string): HTMLElement {
    const hit = this.cache.get(this.key(path, b));
    return hit ? (hit.cloneNode(true) as HTMLElement) : fallback(b);
  }
}

function fallback(b: MdBlock): HTMLElement {
  const d = document.createElement("div");
  const tag =
    b.kind === "heading" ? `h${Math.min(6, Math.max(1, b.level ?? 2))}` : b.kind === "list" ? "ul" : "p";
  const el = document.createElement(tag);
  el.textContent = b.raw;
  d.appendChild(el);
  return d;
}
