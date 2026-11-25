import type { DocSettings, PaperId } from "./types";

export interface TemplatePalette {
  accent: string;
  ink: string;
  muted: string;
  rule: string;
  tint: string;
}

export interface Template {
  id: string;
  name: string;
  /** 一句话用途 */
  purpose: string;
  /** 版式特征，面板里显示 */
  traits: string[];
  /** 参考的出版物 id，见 references.ts */
  refs: string[];
  palette: TemplatePalette;
  /** 相对默认设置的覆盖 */
  settings: Partial<Omit<DocSettings, "margins" | "typo" | "furniture" | "cover" | "toc" | "chapter">> & {
    margins?: Partial<DocSettings["margins"]>;
    typo?: Partial<DocSettings["typo"]>;
    furniture?: Partial<DocSettings["furniture"]>;
    cover?: Partial<DocSettings["cover"]>;
    toc?: Partial<DocSettings["toc"]>;
    chapter?: Partial<DocSettings["chapter"]>;
  };
}

const baseFurniture: DocSettings["furniture"] = {
  headerOn: false,
  headerText: "",
  headerPageNo: false,
  headerSize: 8.5,
  headerRule: false,
  headerAlign: "right",
  footerOn: true,
  footerText: "",
  footerPageNo: true,
  footerSize: 9,
  footerRule: false,
  footerAlign: "center",
};

const baseToc: DocSettings["toc"] = {
  on: false,
  depth: 2,
  title: "目录",
  dotLeader: true,
  ownPage: true,
};

const baseChapter: DocSettings["chapter"] = {
  ownPage: true,
  bigNumber: false,
  rule: false,
  upper: false,
};

const baseCover: DocSettings["cover"] = {
  on: false,
  title: "",
  subtitle: "",
  author: "",
  date: "",
  rule: true,
  align: "center",
};

export const TEMPLATES: Template[] = [
  {
    id: "article",
    name: "文章",
    purpose: "单篇议论或说明文，从头读到尾，不需要封面和目录。",
    traits: ["单栏", "首行缩进 2 字", "无页眉", "页脚居中页码"],
    refs: ["gov-work-report", "progit-zh", "chinese-copywriting"],
    palette: { accent: "#1f4e79", ink: "#1a1a1a", muted: "#6b6b6b", rule: "#d8d2c8", tint: "#f5f2ec" },
    settings: {
      paper: "A4",
      margins: { top: 24, right: 20, bottom: 22, left: 20 },
      typo: { fontSize: 10.5, lineHeight: 1.7, paraIndent: 2, paraSpace: 0 },
      furniture: { ...baseFurniture, footerOn: true, footerPageNo: true },
      toc: { ...baseToc, on: false },
      cover: { ...baseCover, on: false },
      chapter: { ...baseChapter, ownPage: false },
    },
  },
  {
    id: "report",
    name: "正式报告",
    purpose: "有封面、目录、章节编号的正式文档，适合对外提交。",
    traits: ["封面 + 目录", "章起新页", "页眉书名 + 横线", "小四宋体"],
    refs: ["gb9704", "gb7713", "gov-five-year-plan"],
    palette: { accent: "#7a1f1f", ink: "#1a1a1a", muted: "#5c5c5c", rule: "#c9c2b6", tint: "#f7f4ef" },
    settings: {
      paper: "A4",
      margins: { top: 26, right: 22, bottom: 24, left: 24 },
      typo: { fontSize: 12, lineHeight: 1.75, paraIndent: 2, paraSpace: 0, titleScale: 1.9 },
      furniture: {
        ...baseFurniture,
        headerOn: true,
        headerText: "{{book}}",
        headerSize: 9,
        headerRule: true,
        headerAlign: "right",
        footerOn: true,
        footerPageNo: true,
        footerSize: 9,
      },
      toc: { ...baseToc, on: true, depth: 2 },
      cover: { ...baseCover, on: true, align: "center", rule: true },
      chapter: { ...baseChapter, ownPage: true, bigNumber: true, rule: true },
    },
  },
  {
    id: "minutes",
    name: "会议纪要",
    purpose: "会开完当天发出去，条目清楚、能扫读、能追责。",
    traits: ["无首行缩进", "页眉左纪要名右页码", "表格跨页重表头", "小四行距紧"],
    refs: ["gb9704", "minutes-un", "worldbank-report"],
    palette: { accent: "#1d5b52", ink: "#1a1a1a", muted: "#606060", rule: "#cfd8d3", tint: "#f2f7f5" },
    settings: {
      paper: "A4",
      margins: { top: 22, right: 20, bottom: 20, left: 20 },
      typo: { fontSize: 10.5, lineHeight: 1.65, paraIndent: 0, paraSpace: 4, titleScale: 1.6 },
      furniture: {
        ...baseFurniture,
        headerOn: true,
        headerText: "{{book}}",
        headerSize: 8.5,
        headerRule: true,
        headerAlign: "left",
        headerPageNo: true,
        footerOn: false,
        footerPageNo: false,
      },
      toc: { ...baseToc, on: false },
      cover: { ...baseCover, on: false },
      chapter: { ...baseChapter, ownPage: false },
    },
  },
  {
    id: "handover",
    name: "交接资料",
    purpose: "离职、转岗、项目移交：谁接手都能按清单把事接下去。",
    traits: ["清单式", "页眉带版本", "表格与勾选框为主", "目录到二级"],
    refs: ["gb9704", "unesco-gem", "itil-handover"],
    palette: { accent: "#8a5a00", ink: "#1a1a1a", muted: "#6b6357", rule: "#ded5c4", tint: "#faf6ec" },
    settings: {
      paper: "A4",
      margins: { top: 22, right: 19, bottom: 21, left: 19 },
      typo: { fontSize: 10.5, lineHeight: 1.68, paraIndent: 0, paraSpace: 3, titleScale: 1.5 },
      furniture: {
        ...baseFurniture,
        headerOn: true,
        headerText: "{{book}} · 交接",
        headerSize: 8.5,
        headerRule: true,
        headerAlign: "left",
        headerPageNo: true,
      },
      toc: { ...baseToc, on: true, depth: 2 },
      cover: { ...baseCover, on: true, align: "left", rule: false },
      chapter: { ...baseChapter, ownPage: true, bigNumber: false, rule: true },
    },
  },
  {
    id: "lecture",
    name: "课程讲义",
    purpose: "一讲一章，学生课前预习、课后复习都用这一份。",
    traits: ["章首页大标题", "正文 11pt 松行距", "页脚讲义标记", "左宽右窄边距"],
    refs: ["pep-textbook", "mit-ocw-notes", "gb7713"],
    palette: { accent: "#1f4e79", ink: "#1a1a1a", muted: "#5f6670", rule: "#cdd6e0", tint: "#f1f5fa" },
    settings: {
      paper: "A4",
      margins: { top: 25, right: 18, bottom: 23, left: 24 },
      typo: { fontSize: 11, lineHeight: 1.8, paraIndent: 0, paraSpace: 6, titleScale: 2.1 },
      furniture: {
        ...baseFurniture,
        headerOn: false,
        footerOn: true,
        footerText: "{{chapter}}",
        footerPageNo: true,
        footerSize: 9,
        footerAlign: "center",
      },
      toc: { ...baseToc, on: true, depth: 2 },
      cover: { ...baseCover, on: false },
      chapter: { ...baseChapter, ownPage: true, bigNumber: true, rule: true, upper: false },
    },
  },
  {
    id: "manual",
    name: "技术手册",
    purpose: "代码、命令、长表格密集；查得多、读得少。",
    traits: ["窄边距长行", "代码带行号可换行", "目录到三级", "页眉章节名"],
    refs: ["progit-zh", "python-docs-zh", "gb7713"],
    palette: { accent: "#2b4a6f", ink: "#15181c", muted: "#5b636d", rule: "#c8ced6", tint: "#f2f4f7" },
    settings: {
      paper: "A4",
      margins: { top: 20, right: 16, bottom: 18, left: 18 },
      typo: { fontSize: 9.5, lineHeight: 1.55, paraIndent: 0, paraSpace: 3, titleScale: 1.7 },
      furniture: {
        ...baseFurniture,
        headerOn: true,
        headerText: "{{chapter}}",
        headerSize: 8,
        headerRule: true,
        headerAlign: "right",
        headerPageNo: true,
        footerOn: false,
        footerPageNo: false,
      },
      toc: { ...baseToc, on: true, depth: 3 },
      cover: { ...baseCover, on: true, align: "left", rule: true },
      chapter: { ...baseChapter, ownPage: true, bigNumber: false, rule: true },
    },
  },
  {
    id: "anthology",
    name: "研究汇编",
    purpose: "多篇论文或调研合成一册，每篇独立起页。",
    traits: ["双栏", "每篇起新页", "摘要块细竖线", "参考文献小一号"],
    refs: ["gb7713", "cnki-journal-cn", "unesco-gem"],
    palette: { accent: "#3b3b6d", ink: "#1a1a1a", muted: "#5e5e6b", rule: "#d3d3de", tint: "#f4f4f9" },
    settings: {
      paper: "A4",
      margins: { top: 24, right: 20, bottom: 22, left: 20 },
      typo: { fontSize: 10, lineHeight: 1.62, paraIndent: 2, paraSpace: 0, titleScale: 1.6 },
      columns: 2,
      columnGap: 8,
      furniture: {
        ...baseFurniture,
        headerOn: true,
        headerText: "{{book}}",
        headerSize: 8.5,
        headerRule: false,
        headerAlign: "center",
        footerOn: true,
        footerPageNo: true,
        footerSize: 9,
      },
      toc: { ...baseToc, on: true, depth: 1 },
      cover: { ...baseCover, on: true, align: "center", rule: true },
      chapter: { ...baseChapter, ownPage: true, bigNumber: false, rule: false },
    },
  },
  {
    id: "portfolio",
    name: "图文作品集",
    purpose: "图为主、字为辅，翻着看的一册。",
    traits: ["大图满栏", "图注小字居中", "无首行缩进", "宽松留白"],
    refs: ["apple-hig-typography", "moma-catalog", "chinese-copywriting"],
    palette: { accent: "#2f2f2f", ink: "#141414", muted: "#6e6e6e", rule: "#e0ddd8", tint: "#faf9f7" },
    settings: {
      paper: "A4",
      margins: { top: 20, right: 18, bottom: 20, left: 18 },
      typo: { fontSize: 10, lineHeight: 1.75, paraIndent: 0, paraSpace: 8, titleScale: 1.8 },
      furniture: {
        ...baseFurniture,
        headerOn: false,
        footerOn: true,
        footerPageNo: true,
        footerSize: 8.5,
        footerAlign: "center",
      },
      toc: { ...baseToc, on: false },
      cover: { ...baseCover, on: true, align: "center", rule: true },
      chapter: { ...baseChapter, ownPage: true, bigNumber: false, rule: false },
    },
  },
  {
    id: "worksheet",
    name: "练习册",
    purpose: "题目 + 作答空位，打印出来能直接写。",
    traits: ["行距 2.0 留答题空", "题号醒目", "页脚第 X 页 / 共 Y 页", "无目录"],
    refs: ["pep-textbook", "cambridge-pastpaper", "gb9704"],
    palette: { accent: "#245c3a", ink: "#1a1a1a", muted: "#616a63", rule: "#cfd9d2", tint: "#f3f8f4" },
    settings: {
      paper: "A4",
      margins: { top: 22, right: 20, bottom: 22, left: 22 },
      typo: { fontSize: 11, lineHeight: 2, paraIndent: 0, paraSpace: 10, titleScale: 1.7 },
      furniture: {
        ...baseFurniture,
        headerOn: true,
        headerText: "{{book}}",
        headerSize: 8.5,
        headerRule: true,
        headerAlign: "left",
        headerPageNo: false,
        footerOn: true,
        footerText: "第 {{page}} 页 / 共 {{total}} 页",
        footerPageNo: false,
        footerSize: 9,
      },
      toc: { ...baseToc, on: false },
      cover: { ...baseCover, on: true, align: "center", rule: true },
      chapter: { ...baseChapter, ownPage: true, bigNumber: false, rule: true },
    },
  },
  {
    id: "longform",
    name: "长文集",
    purpose: "几万字往上，双面装订，能摊平读很久。",
    traits: ["A5 短行", "双面镜像页边距", "装订边 5mm", "页眉外侧页码"],
    refs: ["progit-zh", "penguin-classics", "chinese-copywriting"],
    palette: { accent: "#4a3b2a", ink: "#1b1a18", muted: "#6a6459", rule: "#d9d2c4", tint: "#f7f4ee" },
    settings: {
      paper: "A5",
      margins: { top: 18, right: 15, bottom: 17, left: 15 },
      gutter: 5,
      mirror: true,
      typo: { fontSize: 9.5, lineHeight: 1.9, paraIndent: 1, paraSpace: 0, titleScale: 1.9 },
      furniture: {
        ...baseFurniture,
        headerOn: true,
        headerText: "",
        headerSize: 8,
        headerRule: false,
        headerAlign: "right",
        headerPageNo: false,
        footerOn: true,
        footerPageNo: true,
        footerSize: 8.5,
        footerAlign: "center",
      },
      toc: { ...baseToc, on: true, depth: 2 },
      cover: { ...baseCover, on: true, align: "center", rule: true },
      chapter: { ...baseChapter, ownPage: true, bigNumber: false, rule: true },
    },
  },
];

export function getTemplate(id: string): Template {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}

/** 把模板覆盖合成为一份完整设置 */
export function settingsFromTemplate(id: string, paper?: PaperId): DocSettings {
  const t = getTemplate(id);
  const s = t.settings;
  const doc: DocSettings = {
    paper: paper ?? s.paper ?? "A4",
    margins: { top: 24, right: 20, bottom: 22, left: 20, ...(s.margins ?? {}) },
    gutter: s.gutter ?? 0,
    mirror: s.mirror ?? false,
    typo: {
      fontFamily: 'var(--ntb-font-song)',
      headingFamily: 'var(--ntb-font-hei)',
      fontSize: 10.5,
      lineHeight: 1.7,
      paraIndent: 2,
      paraSpace: 0,
      justify: true,
      titleScale: 1.8,
      ...(s.typo ?? {}),
    },
    columns: s.columns ?? 1,
    columnGap: s.columnGap ?? 8,
    firstPageNumber: 1,
    frontMatterRoman: true,
    furniture: { ...baseFurniture, ...(s.furniture ?? {}) },
    cover: { ...baseCover, ...(s.cover ?? {}) },
    toc: { ...baseToc, ...(s.toc ?? {}) },
    chapter: { ...baseChapter, ...(s.chapter ?? {}) },
    minFill: 0.28,
  };
  return doc;
}
