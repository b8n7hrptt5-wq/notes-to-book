import type { DocSettings, Project, ProjectItem, ScopedRule } from "./types";
export type { Project };
import type { DocSettings as _DS } from "./types";
import { settingsFromTemplate } from "./templates";

export const PROJECT_VERSION = 1;

export function newProject(name: string, templateId = "article"): Project {
  return {
    version: PROJECT_VERSION,
    id: `p${Date.now().toString(36)}`,
    name,
    templateId,
    settings: settingsFromTemplate(templateId),
    items: [],
    skipped: [],
    excludedBlocks: [],
    rules: [],
    updatedAt: Date.now(),
  };
}

/** 内容指纹：用来在文件被改名/移动后重新对上 */
export function fingerprint(md: string): string {
  const s = md.slice(0, 4000);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${(h >>> 0).toString(36)}-${md.length.toString(36)}`;
}

export function addItems(p: Project, items: { path: string; md: string; role?: ProjectItem["role"] }[]) {
  for (const it of items) {
    if (p.items.some((x) => x.path === it.path)) continue;
    // 每篇笔记默认独立成章：多篇合并时按选稿顺序（选稿面板里按路径/日期排好）
    // 各占一章，比默认「第一篇是章、其余都是节」更符合合订本的习惯
    p.items.push({
      path: it.path,
      role: it.role ?? "chapter",
      fingerprint: fingerprint(it.md),
    });
  }
  p.updatedAt = Date.now();
}

export function moveItem(p: Project, from: number, to: number) {
  if (from === to || from < 0 || to < 0 || from >= p.items.length || to >= p.items.length) return;
  const [it] = p.items.splice(from, 1);
  p.items.splice(to, 0, it);
  p.updatedAt = Date.now();
}

/** 换模板：保留选稿与章节编排，只换版式 */
export function retemplate(p: Project, templateId: string) {
  p.templateId = templateId;
  const next = settingsFromTemplate(templateId, p.settings.paper);
  // 用户改过的封面文字要留下来
  next.cover.title = next.cover.title || p.settings.cover.title;
  next.cover.subtitle = p.settings.cover.subtitle;
  next.cover.author = p.settings.cover.author;
  next.cover.date = p.settings.cover.date;
  next.cover.on = p.settings.cover.on || next.cover.on;
  next.toc.on = p.settings.toc.on || next.toc.on;
  p.settings = next;
  p.updatedAt = Date.now();
}

export function applyRule(p: Project, rule: ScopedRule) {
  p.rules.push(rule);
  p.updatedAt = Date.now();
}

export function removeRuleAt(p: Project, index: number) {
  p.rules.splice(index, 1);
  p.updatedAt = Date.now();
}

export function summarize(p: Project) {
  const chapters = p.items.filter((i) => i.role === "chapter").length;
  return {
    items: p.items.length,
    chapters,
    sections: p.items.length - chapters,
    rules: p.rules.length,
    skipped: p.skipped.length,
  };
}

/** 序列化时只留必要字段，便于版本兼容 */
export function serialize(p: Project): string {
  return JSON.stringify({ ...p, updatedAt: Date.now() }, null, 2);
}

export function deserialize(json: string): Project {
  const raw = JSON.parse(json) as Project;
  if (!raw.settings) throw new Error("项目文件损坏：缺少 settings");
  raw.items = raw.items ?? [];
  raw.rules = raw.rules ?? [];
  raw.skipped = raw.skipped ?? [];
  raw.excludedBlocks = raw.excludedBlocks ?? [];
  return raw;
}
