/**
 * 共用类型。这一层不依赖 Obsidian，可以单独在浏览器里跑（测试台用的就是它）。
 */

export type PaperId = "A4" | "A5" | "B5" | "Letter";

export interface Paper {
  id: PaperId;
  name: string;
  /** 宽高，毫米 */
  w: number;
  h: number;
}

export const PAPERS: Record<PaperId, Paper> = {
  A4: { id: "A4", name: "A4", w: 210, h: 297 },
  A5: { id: "A5", name: "A5", w: 148, h: 210 },
  B5: { id: "B5", name: "B5", w: 176, h: 250 },
  Letter: { id: "Letter", name: "Letter", w: 215.9, h: 279.4 },
};

export type BlockKind =
  | "heading"
  | "para"
  | "list"
  | "table"
  | "code"
  | "image"
  | "quote"
  | "callout"
  | "math"
  | "mermaid"
  | "hr"
  | "unknown";

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Typo {
  fontFamily: string;
  headingFamily: string;
  fontSize: number; // pt
  lineHeight: number; // 倍数
  paraIndent: number; // em，正文首行缩进
  paraSpace: number; // pt，段后距
  justify: boolean;
  titleScale: number; // 一级标题相对正文的倍数
}

export interface Furniture {
  headerOn: boolean;
  headerText: string; // 支持 {{book}} {{chapter}} {{page}}
  headerPageNo: boolean;
  headerSize: number; // pt
  headerRule: boolean;
  headerAlign: "left" | "center" | "right";
  footerOn: boolean;
  footerText: string;
  footerPageNo: boolean;
  footerSize: number;
  footerRule: boolean;
  footerAlign: "left" | "center" | "right";
}

export interface CoverSettings {
  on: boolean;
  title: string;
  subtitle: string;
  author: string;
  date: string;
  rule: boolean;
  align: "center" | "left";
}

export interface TocSettings {
  on: boolean;
  depth: number; // 1..3
  title: string;
  dotLeader: boolean;
  ownPage: boolean;
}

export interface ChapterSettings {
  ownPage: boolean;
  bigNumber: boolean;
  rule: boolean;
  upper: boolean;
}

export interface DocSettings {
  paper: PaperId;
  margins: Margins;
  gutter: number; // 装订边（mm），加在订口一侧
  mirror: boolean; // 单双页镜像边距
  typo: Typo;
  columns: number;
  columnGap: number;
  firstPageNumber: number;
  frontMatterRoman: boolean;
  furniture: Furniture;
  cover: CoverSettings;
  toc: TocSettings;
  chapter: ChapterSettings;
  /** 页尾允许留白的最小比例，低于此值把段落拆开，避免大片空白 */
  minFill: number;
}

/** 单个元素的局部调整 */
export interface ElemOpts {
  breakBefore?: boolean;
  breakAfter?: boolean;
  keepWithNext?: boolean;
  rotate?: boolean; // 横向页（内容旋转 90°）
  repeatHeader?: boolean; // 表格跨页重复表头
  wrap?: boolean; // 代码换行
  fontSize?: number; // pt，仅对该元素
  maxHeightPct?: number; // 图片最大高度占版心比例
  hide?: boolean;
  align?: "left" | "center" | "right";
  columns?: 1 | 2;
}

export type RuleScope = "block" | "chapter" | "doc";

export interface ScopedRule {
  scope: RuleScope;
  /** scope=chapter 时限定章节序号 */
  chapterIndex?: number;
  /** scope=block 时精确到某个块 */
  blockId?: string;
  types: BlockKind[];
  opts: ElemOpts;
}

export type ItemRole = "chapter" | "section";

export interface ProjectItem {
  path: string;
  role: ItemRole;
  /** 手动标题；空则用文件里的第一个一级标题 */
  title?: string;
  /** 文件内容指纹，用来发现「文件改名/移动」 */
  fingerprint?: string;
}

export interface Project {
  version: 1;
  id: string;
  name: string;
  templateId: string;
  settings: DocSettings;
  items: ProjectItem[];
  /** 用户主动排除的文件 */
  skipped: string[];
  /** 用户主动排除的块 id */
  excludedBlocks: string[];
  rules: ScopedRule[];
  updatedAt: number;
}

/** 排版中的一个源块 */
export interface SourceBlock {
  id: string;
  kind: BlockKind;
  /** 笔记路径（vault 相对） */
  srcPath: string;
  /** 源文件内的 1-based 行号 */
  srcLine: number;
  /** 用于核对的纯文本 */
  text: string;
  level?: number;
  /** 表格：每行每列的文本，供逐行核对 */
  rows?: string[][];
  chapterIndex: number;
  chapterTitle: string;
  /** 代码块行数 */
  codeLines?: number;
  /** 图片引用的原始地址 */
  srcRaw?: string;
  /** 这个块是否被「导出后核对」当作必须出现的项 */
  mustAppear: boolean;
}

export interface PlacedBlock {
  id: string;
  kind: BlockKind;
  page: number;
  column: number;
  /** 被裁切（放不下且不可拆） */
  clipped: boolean;
  /** 被拆成多段时，这是第几段（从 1 开始） */
  part: number;
}

export interface PagePlan {
  index: number; // 1-based，物理页
  kind: "cover" | "toc" | "chapter" | "body" | "appendix";
  label: string; // 显示的页码文字
  columns: number;
  rotate: boolean;
  chapterIndex?: number;
  chapterTitle?: string;
}

export interface PaginationResult {
  pages: PagePlan[];
  placed: PlacedBlock[];
  /** 每个标题落在第几页，供目录与核对用 */
  headings: { id: string; level: number; text: string; page: number; chapterIndex: number }[];
  warnings: LayoutWarning[];
}

export interface LayoutWarning {
  kind: "clipped" | "unsplittable" | "empty-page" | "wide-table" | "long-code" | "missing-image";
  blockId?: string;
  page?: number;
  srcPath?: string;
  srcLine?: number;
  detail: string;
}
