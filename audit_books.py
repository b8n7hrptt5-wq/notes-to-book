#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
audit_books.py — 打印稿 PDF 成品验收检查（C1–C13）

用法:
    python3 audit_books.py --pdf <PDF路径> [--out <结果JSON路径>]
    python3 audit_books.py --pdf <PDF路径> --render 3,8,12-14 --dir /tmp/png

退出码: 0 = PASS(C7/C8/C10/C12/C13 全部通过), 1 = FAIL, 2 = 参数/文件错误

依赖: pymupdf（import pymupdf 或 fitz）。不依赖 pypdf/reportlab。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
import traceback
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

try:  # PyMuPDF 新版入口
    import pymupdf as fitz  # type: ignore
except ImportError:  # 兼容旧版
    try:
        import fitz  # type: ignore
    except ImportError:
        sys.stderr.write("错误: 缺少 pymupdf，请先安装: python3 -m pip install pymupdf\n")
        raise SystemExit(2)

# ----------------------------------------------------------------------------
# 检查项配置
# ----------------------------------------------------------------------------

CHECK_ORDER = [f"C{i}" for i in range(1, 14)]

# 命中即 FAIL 的硬性检查；其余为警告级
HARD_CHECKS = {"C7", "C8", "C10", "C12", "C13"}

TITLE = {
    "C1": "页数与页码",
    "C2": "目录条目",
    "C3": "只有标题的页",
    "C4": "页尾留白",
    "C5": "题数=答案条数",
    "C6": "题号连续",
    "C7": "图块无壳残留",
    "C8": "无字符拼化学式",
    "C9": "章标题位置",
    "C10": "公式残留",
    "C11": "索引指向",
    "C12": "死链残留",
    "C13": "单册页数上限",
}

# 正文阈值
BODY_MIN_CHARS = 120          # C3: 正文字符数低于此值视为"只有标题"
TAIL_GAP_RATIO = 0.20         # C4: 页尾留白超过版心高度的比例
TAIL_GAP_TOLERANCE = 3        # C4: 允许的异常页数（参考项）
MAX_PAGES = 400               # C13

# C7 图块残留
HARD_TOKENS = ["```", "flowchart", "-->", "mermaid", "graph TD"]
SOFT_TOKEN_RE = re.compile(r"(?<![A-Za-z])text(?![A-Za-z])")

# C8 字符拼化学式（比规范里的正则更完整：长 token 优先，避免 H2SO4 只截到 H2）
FORMULA_TOKENS = [
    "Ca(OH)2", "H2SO4", "CaCO3", "NaOH", "CH4", "H2O", "NH3", "CO2", "SO2",
    "Cl2", "Fe2+", "Fe3+", "Cu2+", "H2", "O2", "N2", "Fe2", "Fe3", "Cu2",
]
FORMULA_RE = re.compile(
    r"(?<![A-Za-z0-9])(" + "|".join(re.escape(t) for t in FORMULA_TOKENS) + r")(?![A-Za-z])"
)

# C9 章标题字号倍数
TITLE_SCALE = 1.60           # 章标题字号至少是正文的 1.6 倍
TITLE_PAGE_RATIO = 0.85      # 且不低于本页最大字号的 85%（排除 16pt 小标题误判）

# 目录 / 索引条目：名称 + 引导符 + 页码
LEADER_RE = re.compile(r"^(?P<name>.+?)[\s.．·‥…\-—]{2,}\s*(?P<page>\d{1,4})\s*$")
PLAIN_TAIL_RE = re.compile(r"^(?P<name>\S.*?)\s{2,}(?P<page>\d{1,4})\s*$")

PRACTICE_RE = re.compile(
    r"^(练习|练习题|课堂练习|课后练习|巩固练习|随堂练习|习题|课堂检测|达标检测|基础练习)\s*$"
)
ANSWER_RE = re.compile(r"^(参考答案|答案|答案与解析|答案及解析|解析与答案|参考答案与解析)\s*$")

QNUM_RE = re.compile(r"^\s*(\d{1,3})\s*[.．、]\s*")
ANUM_RE = re.compile(r"^\s*(\d{1,3})\s*[.．、)）]\s*")
BULLET_NUM_RE = re.compile(r"^\s*[-–—•·*+]\s*\d{1,3}\s*[.．、]")
# 小节标题，如 "1.2 常见的强酸"——用来截断答案区，避免把下一节的编号算进答案
# 两个数字之间不能有空格，否则 "3. 22.4 L …" 这种答案行会被误判成 3.22 节
SECTION_RE = re.compile(r"^\s*\d{1,2}[.．]\d{1,2}(?=[\s\u4e00-\u9fff]|$)")

FOOTER_NUM_PATS = [
    re.compile(r"^[\s\-–—－·•—]*?(\d{1,4})[\s\-–—－·•—]*$"),
    re.compile(r"^第\s*(\d{1,4})\s*页$"),
    re.compile(r"^(\d{1,4})\s*[/／]\s*\d{1,4}$"),
]

CJK_ALNUM_RE = re.compile(r"[0-9A-Za-z\u4e00-\u9fff\u3400-\u4dbf]")


# ----------------------------------------------------------------------------
# 数据结构
# ----------------------------------------------------------------------------

@dataclass
class Char:
    c: str
    size: float
    oy: float
    x0: float
    y1: float


@dataclass
class Line:
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    size: float
    chars: List[Char] = field(default_factory=list)


@dataclass
class PageInfo:
    no: int                      # 0 基 PDF 页序
    w: float
    h: float
    lines: List[Line] = field(default_factory=list)
    text: str = ""
    label: Optional[int] = None  # 页脚印刷页码
    label_raw: str = ""
    footer: Optional[Line] = None

    @property
    def display(self) -> int:    # 人看的页码（1 基 PDF 页序）
        return self.no + 1


@dataclass
class Book:
    pages: List[PageInfo]
    body_size: float
    content_top: float
    content_bottom: float
    toc_pages: List[int] = field(default_factory=list)
    chapter_pages: Dict[int, str] = field(default_factory=dict)
    first_body: int = 0                       # 正文首页的 0 基序号（有印刷页码的第一页）
    front_pages: List[int] = field(default_factory=list)     # 前置页：封面/前言/凡例/目录
    index_pages: List[int] = field(default_factory=list)     # 附录二 知识定位
    appendix_start: Optional[int] = None                     # 附录起点
    chapter_intro_pages: List[int] = field(default_factory=list)  # 专题/章导览页
    lesson_ranges: List[Tuple[int, int, str]] = field(default_factory=list)  # (起, 止, 名称)
    lesson_end_pages: List[int] = field(default_factory=list)                # 课时末页

    @property
    def content_height(self) -> float:
        return max(self.content_bottom - self.content_top, 1.0)

    @property
    def lesson_end_set(self) -> set:
        return set(self.lesson_end_pages)


CHAPTER_INTRO_RE = re.compile(r"本章\d+课")


def pct(values: List[float], q: float) -> float:
    if not values:
        return 0.0
    vs = sorted(values)
    i = int(round(q * (len(vs) - 1)))
    return vs[max(0, min(i, len(vs) - 1))]


# ----------------------------------------------------------------------------
# 文本工具
# ----------------------------------------------------------------------------

_FULL2HALF = str.maketrans({
    "０": "0", "１": "1", "２": "2", "３": "3", "４": "4",
    "５": "5", "６": "6", "７": "7", "８": "8", "９": "9",
    "（": "(", "）": ")", "：": ":", "；": ";", "，": ",",
    "。": ".", "、": ",", "－": "-", "—": "-", "～": "~", "　": " ",
})


def norm(s: str) -> str:
    """归一化：全角转半角、去空白、统一标点、小写。用于包含比对。"""
    if not s:
        return ""
    s = s.replace("\u00a0", " ").translate(_FULL2HALF)
    s = re.sub(r"\s+", "", s)
    return s.lower()


def strip_heading(t: str) -> str:
    """去掉目录/索引条目开头的编号（第一章 / 1. / 01 / （一））。"""
    s = (t or "").strip()
    s = re.sub(r"^第[一二三四五六七八九十百零〇\d]+[章节讲课篇部分]\s*", "", s)
    s = re.sub(r"^[（(][一二三四五六七八九十\d]{1,3}[)）]\s*", "", s)
    s = re.sub(r"^\d{1,3}(\s*[.．]\s*\d{1,3})*\s*[.．、:：)）]?\s*", "", s)
    s = re.sub(r"^\d{2}\s+", "", s)
    return s.strip() or (t or "").strip()


def fmt_pages(nums: List[int], limit: int = 20) -> str:
    """[3,5,6,7,12] -> '3,5-7,12'（超过 limit 个则截断）。"""
    nums = sorted(set(int(n) for n in nums))
    if not nums:
        return ""
    spans: List[str] = []
    s = prev = nums[0]
    for n in nums[1:]:
        if n == prev + 1:
            prev = n
            continue
        spans.append(str(s) if s == prev else "%d-%d" % (s, prev))
        s = prev = n
    spans.append(str(s) if s == prev else "%d-%d" % (s, prev))
    if len(spans) > limit:
        return ",".join(spans[:limit]) + " …(共 %d 处)" % len(nums)
    return ",".join(spans)


def count_chars(text: str) -> int:
    return len(CJK_ALNUM_RE.findall(text or ""))


def snippet(text: str, start: int, end: int, pad: int = 10) -> str:
    a = max(0, start - pad)
    b = min(len(text), end + pad)
    return text[a:b].replace("\n", " ").strip()


def parse_page_list(spec: str) -> List[int]:
    out: List[int] = []
    for part in (spec or "").replace("，", ",").split(","):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r"(\d+)\s*[-~]\s*(\d+)", part)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if a > b:
                a, b = b, a
            out.extend(range(a, b + 1))
            continue
        if part.isdigit():
            out.append(int(part))
    return sorted(set(n for n in out if n > 0))


# ----------------------------------------------------------------------------
# PDF 解析
# ----------------------------------------------------------------------------

def extract_page(doc, i: int) -> PageInfo:
    page = doc.load_page(i)
    raw = page.get_text("rawdict")
    lines: List[Line] = []
    for block in raw.get("blocks", []):
        if block.get("type", 0) != 0:
            continue
        for ln in block.get("lines", []):
            chars: List[Char] = []
            dom_size, dom_n = 0.0, -1
            for sp in ln.get("spans", []):
                try:
                    sz = float(sp.get("size", 0) or 0)
                except (TypeError, ValueError):
                    sz = 0.0
                n = 0
                for ch in sp.get("chars", []):
                    c = ch.get("c", "")
                    if not c:
                        continue
                    ox, oy = ch.get("origin", (0.0, 0.0))
                    bb = ch.get("bbox", (0.0, 0.0, 0.0, 0.0))
                    chars.append(Char(c, sz, float(oy), float(bb[0]), float(bb[3])))
                    n += 1
                if n > dom_n:
                    dom_n, dom_size = n, sz
            if not chars:
                continue
            bb = ln.get("bbox") or (
                min(c.x0 for c in chars), 0.0, max(c.x0 for c in chars), max(c.y1 for c in chars)
            )
            lines.append(
                Line("".join(c.c for c in chars), float(bb[0]), float(bb[1]),
                     float(bb[2]), float(bb[3]), dom_size, chars)
            )
    lines.sort(key=lambda l: (round(l.y0, 1), l.x0))

    # 先按"视觉行"聚簇（目录/索引的 名称·点线·页码 是三段独立文字，
    # 且页码可能与点线不在同一 y0，只靠 y 相等会拼错顺序），再按 x 排序拼接。
    rows: List[List[Line]] = []
    for l in lines:
        placed = False
        for members in rows[-4:]:
            rep = members[0]
            ov = min(rep.y1, l.y1) - max(rep.y0, l.y0)
            min_h = min(rep.y1 - rep.y0, l.y1 - l.y0)
            if ov > 0 and min_h > 0 and ov >= 0.5 * min_h:
                members.append(l)
                rep.y0 = min(rep.y0, l.y0)
                rep.y1 = max(rep.y1, l.y1)
                placed = True
                break
        if not placed:
            rows.append([l])

    merged: List[Line] = []
    for members in rows:
        members.sort(key=lambda m: m.x0)
        base = members[0]
        text = base.text
        chars = list(base.chars)
        x1 = base.x1
        y0, y1, size = base.y0, base.y1, base.size
        for m in members[1:]:
            gap = m.x0 - x1
            joiner = "" if gap < 2.0 else (" " if gap < 20.0 else "\t")
            for jc in joiner:  # 占位字符，保证 chars 与 text 严格对齐
                chars.append(Char(jc, m.size, m.chars[0].oy if m.chars else 0.0, m.x0, m.y1))
            text += joiner + m.text
            chars.extend(m.chars)
            x1 = max(x1, m.x1)
            y0, y1, size = min(y0, m.y0), max(y1, m.y1), max(size, m.size)
        merged.append(Line(text, base.x0, y0, x1, y1, size, chars))
    lines = merged

    p = PageInfo(i, float(page.rect.width), float(page.rect.height), lines)
    p.text = "\n".join(l.text for l in lines)
    return p


def detect_footer(p: PageInfo) -> None:
    """从页脚（或页眉）区域取印刷页码。"""
    h = p.h
    cands = [l for l in p.lines if l.y0 >= 0.88 * h]
    if not cands:
        cands = [l for l in p.lines if l.y1 <= 0.07 * h]
    for l in reversed(cands):
        t = l.text.strip()
        if not t or count_chars(t) > 12:
            continue
        for pat in FOOTER_NUM_PATS:
            m = pat.match(t)
            if not m:
                continue
            try:
                v = int(m.group(1))
            except (TypeError, ValueError):
                continue
            if 0 < v <= 9999:
                p.label, p.label_raw, p.footer = v, t, l
                return


def build_book(pages: List[PageInfo]) -> Book:
    size_weight: Counter = Counter()
    for p in pages:
        for l in p.lines:
            if p.footer is not None and l is p.footer:
                continue
            n = count_chars(l.text)
            if n == 0 or l.size <= 0:
                continue
            size_weight[round(l.size * 2) / 2.0] += n
    body_size = size_weight.most_common(1)[0][0] if size_weight else 10.0

    tops, bottoms = [], []
    for p in pages:
        ls = [l for l in p.lines if (p.footer is None or l is not p.footer) and l.text.strip()]
        if not ls:
            continue
        tops.append(min(l.y0 for l in ls))
        bottoms.append(max(l.y1 for l in ls))
    content_top = statistics.median(tops) if tops else 40.0
    content_bottom = pct(bottoms, 0.85) if bottoms else (pages[0].h * 0.90 if pages else 720.0)
    if content_bottom <= content_top:
        content_bottom = content_top + (pages[0].h * 0.8 if pages else 600.0)

    book = Book(pages, body_size, content_top, content_bottom)

    # 正文首页 = 第一个有印刷页码的页；它之前都是前置页（封面/前言/凡例/目录）
    book.first_body = next((p.no for p in pages if p.label is not None), 0)
    fb = book.first_body
    book.front_pages = list(range(0, fb))

    # 目录页：只在正文之前找，避免把书末"附录二 知识定位"当目录
    for p in pages[:fb] if fb else pages[:3]:
        n_leader = sum(1 for l in p.lines if LEADER_RE.match(l.text.strip()))
        if "目录" in norm(p.text) or n_leader >= 3:
            book.toc_pages.append(p.no)

    toc_set = set(book.toc_pages)

    # 索引页（附录二 知识定位）——只在正文之后找，别把封面/目录里提到的算进来
    book.index_pages = [
        p.no for p in pages
        if p.no >= fb and p.no not in toc_set and "知识定位" in norm(p.text)
    ]

    # 附录起点
    app = [
        p.no for p in pages
        if p.no >= fb and p.no not in toc_set
        and ("附录一" in norm(p.text) or "附录二" in norm(p.text))
    ]
    book.appendix_start = min(app) if app else None

    # 章导览页（"本章 7 课 · 77 个知识点"）
    for p in pages:
        if p.no >= fb and p.no not in toc_set and CHAPTER_INTRO_RE.search(norm(p.text)):
            book.chapter_intro_pages.append(p.no)

    # 章首页（按字号）——旧逻辑保留，供无"本节要点"标记的稿子使用
    for p in pages:
        top = page_title_line(p, body_size)
        if top is not None and top.y0 <= p.h * 0.22:
            book.chapter_pages[p.no] = top.text.strip()

    # 课时切分：以"本节要点"（缺则"知识点梳理"）为课时首页
    starts = [
        p.no for p in pages
        if p.no >= fb and p.no not in toc_set and "本节要点" in norm(p.text)
    ]
    if not starts:
        starts = [
            p.no for p in pages
            if p.no >= fb and p.no not in toc_set and "知识点梳理" in norm(p.text)
        ]
    if starts:
        limit = (book.appendix_start - 1) if book.appendix_start is not None else len(pages) - 1
        ranges: List[Tuple[int, int, str]] = []
        for k, s in enumerate(starts):
            e = (starts[k + 1] - 1) if k + 1 < len(starts) else limit
            if e < s:
                e = s
            ranges.append((s, min(e, len(pages) - 1), lesson_title(pages[s], body_size)))
        book.lesson_ranges = ranges
        ends = {e for _, e, _ in ranges}
        # 专题末课的末页后面跟的是"章导览"页，它也算课时末页
        for ci in book.chapter_intro_pages:
            if ci - 1 >= fb:
                ends.add(ci - 1)
        book.lesson_end_pages = sorted(ends)

    return book


def lesson_title(p: PageInfo, body_size: float) -> str:
    """课时名：页首最大的那行标题，跳过页眉（"化学 必修第一册 专题01 …"）。"""
    cands = [
        l for l in p.lines
        if l.text.strip() and l.y1 > p.h * 0.07 and l.y0 < p.h * 0.30
        and (p.footer is None or l is not p.footer)
    ]
    if not cands:
        return "p%d" % p.display
    mx = max(l.size for l in cands)
    top = [l for l in cands if l.size >= mx * 0.9]
    top.sort(key=lambda l: (l.y0, l.x0))
    for l in top:
        t = l.text.strip()
        if "单元" not in t and len(t) >= 2:
            return t
    return top[0].text.strip()


def page_max_size(p: PageInfo) -> float:
    sizes = [l.size for l in p.lines if (p.footer is None or l is not p.footer) and l.text.strip()]
    return max(sizes) if sizes else 0.0


def title_candidates(p: PageInfo, body_size: float) -> List[Line]:
    pmax = page_max_size(p)
    if pmax <= 0:
        return []
    lo = max(body_size * TITLE_SCALE, pmax * TITLE_PAGE_RATIO)
    return [
        l for l in p.lines
        if l.size >= lo and count_chars(l.text) >= 2
        and (p.footer is None or l is not p.footer)
    ]


def page_title_line(p: PageInfo, body_size: float) -> Optional[Line]:
    cands = title_candidates(p, body_size)
    if not cands:
        return None
    return min(cands, key=lambda l: (l.y0, l.x0))


# ----------------------------------------------------------------------------
# 页码映射
# ----------------------------------------------------------------------------

def label_map(pages: List[PageInfo]) -> Dict[int, PageInfo]:
    m: Dict[int, PageInfo] = {}
    for p in pages:
        if p.label is not None and p.label not in m:
            m[p.label] = p
    return m


def page_by_label(pages: List[PageInfo], m: Dict[int, PageInfo], label: int) -> Optional[PageInfo]:
    if label in m:
        return m[label]
    i = label - 1
    if 0 <= i < len(pages):
        return pages[i]
    return None


# ----------------------------------------------------------------------------
# 结果封装
# ----------------------------------------------------------------------------

def result(ok: bool, detail: str, **extra: Any) -> Dict[str, Any]:
    d: Dict[str, Any] = {"ok": bool(ok), "detail": detail}
    if extra:
        d["extra"] = extra
    return d


def guard(cid: str, fn, *args, **kwargs) -> Dict[str, Any]:
    """任何单项异常都不许影响整轮。"""
    try:
        return fn(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001
        tb = traceback.format_exc(limit=3).strip().splitlines()[-1]
        return result(False, "检查异常: %s: %s" % (type(exc).__name__, exc), traceback=tb)


# ----------------------------------------------------------------------------
# C1 页数与页码
# ----------------------------------------------------------------------------

def check_c1(book: Book) -> Dict[str, Any]:
    pages = book.pages
    total = len(pages)
    if total == 0:
        return result(False, "PDF 无页面")

    labeled = [(p.no, p.label, p.label_raw) for p in pages if p.label is not None]
    if not labeled:
        return result(False, "%d页，未检测到页脚页码（可能不是成品印刷稿）" % total,
                      pages=total, labeled=0)

    # 正文起点 = 第一个页码为 1 的页
    start = next((k for k, (_, v, _) in enumerate(labeled) if v == 1), 0)
    body = labeled[start:]
    body_first_pdf = body[0][0]

    missing = [p.no + 1 for p in pages if p.no >= body_first_pdf and p.label is None]
    dups: List[Tuple[int, int]] = []
    jumps: List[Tuple[int, int, int]] = []
    for k in range(1, len(body)):
        prev_no, prev_v, _ = body[k - 1]
        cur_no, cur_v, _ = body[k]
        if cur_v == prev_v:
            dups.append((cur_no + 1, cur_v))
        elif cur_v != prev_v + 1:
            jumps.append((cur_no + 1, prev_v, cur_v))

    last_v = body[-1][1]
    issues: List[str] = []
    if labeled[start][1] != 1:
        issues.append("首页页码不是 1（是 %s）" % labeled[start][1])
    if missing:
        issues.append("%d 页缺页码(PDF页 %s)" % (len(missing), fmt_pages(missing, 8)))
    if dups:
        issues.append("重号 %d 处(%s)" % (len(dups), ",".join("%d页→%d" % d for d in dups[:6])))
    if jumps:
        issues.append("跳号 %d 处(%s)" % (len(jumps), ",".join(
            "%d页 %d→%d" % j for j in jumps[:6])))

    expect = total - body_first_pdf
    detail = "%d页，页码 1-%d" % (total, last_v)
    if expect != last_v:
        detail += "（正文物理页 %d，与末页码差 %d）" % (expect, expect - last_v)
    if issues:
        detail += "；" + "；".join(issues)
    else:
        detail += " 连续"
    return result(not issues, detail, pages=total, first_label=last_v,
                  missing=missing, dups=dups, jumps=jumps)


# ----------------------------------------------------------------------------
# C2 目录
# ----------------------------------------------------------------------------

def _toc_entries(book: Book) -> List[Tuple[str, int, int]]:
    """只从"目录页～正文首页"之间的页里抓条目，索引页交给 C11。"""
    out: List[Tuple[str, int, int]] = []
    seen = set()
    toc_set = set(book.toc_pages)
    # 「目录页～正文首页」这一段；书籍没有印页码时退化为全册前 15%
    limit = book.first_body if book.first_body > 0 else max(1, int(len(book.pages) * 0.15))
    for no in sorted(toc_set):
        if no >= limit and no >= len(book.pages) * 0.15:
            continue
        for l in book.pages[no].lines:
            t = l.text.strip()
            if not t:
                continue
            m = LEADER_RE.match(t) or PLAIN_TAIL_RE.match(t)
            if not m:
                continue
            raw = m.group("name").strip()
            name = strip_heading(raw)
            try:
                pg = int(m.group("page"))
            except (TypeError, ValueError):
                continue
            if count_chars(name) < 2 or not (1 <= pg <= 9999):
                continue
            if norm(name) in ("目录", "目次"):
                continue
            key = (norm(name), pg)
            if key in seen:
                continue
            seen.add(key)
            out.append((name, pg, no))
    return out


def check_c2(book: Book) -> Dict[str, Any]:
    entries = _toc_entries(book)
    if not book.toc_pages:
        return result(False, "未找到目录页", entries=0, hits=0, fails=[])
    if not entries:
        return result(False, "目录页存在但未解析出条目（引导符/页码可能被拆行）",
                      entries=0, hits=0, fails=[], toc_pages=[p + 1 for p in book.toc_pages])

    lm = label_map(book.pages)
    hits, fails = 0, []
    for name, pg, src in entries:
        target = page_by_label(book.pages, lm, pg)
        if target is None:
            fails.append({"name": name, "page": pg, "why": "页码超出范围"})
            continue
        body = norm(target.text)
        key = norm(name)
        if key and key in body:
            hits += 1
        else:
            fails.append({"name": name, "page": pg, "why": "目标页无此条目"})

    ok = not fails
    detail = "目录 %d 条 / 命中 %d / 失败 %d" % (len(entries), hits, len(fails))
    if fails:
        detail += "：" + "；".join("%s(p%d)" % (f["name"][:18], f["page"]) for f in fails[:8])
    return result(ok, detail, entries=len(entries), hits=hits, fails=fails,
                  toc_pages=[p + 1 for p in book.toc_pages],
                  scanned=[p + 1 for p in book.toc_pages if p < book.first_body])


# ----------------------------------------------------------------------------
# 公共：正文页判定
# ----------------------------------------------------------------------------

def body_page_text(book: Book, p: PageInfo) -> str:
    out = []
    for l in p.lines:
        if p.footer is not None and l is p.footer:
            continue
        out.append(l.text)
    return "\n".join(out)


BLOCK_HEADS = (
    "本节要点", "知识点梳理", "图示理解", "判断与解题流程", "高考考向",
    "必背速查", "易错辨析", "记忆与复习", "记忆要点", "练习", "自测", "附录",
)


def block_head_of(p: PageInfo) -> str:
    """页首是不是某个板块标题（用于判断上一页的留白是不是板块分页造成的）。"""
    for l in p.lines[:5]:
        t = l.text.strip()
        if not t or l.y1 < p.h * 0.07:
            continue
        for b in BLOCK_HEADS:
            if t.startswith(b):
                return b
    return ""


def front_set(book: Book) -> set:
    """前置页：封面、前言、凡例、目录（不印页码那一叠）。"""
    return set(book.front_pages) | set(book.toc_pages)


def appendix_set(book: Book) -> set:
    if book.appendix_start is None:
        return set()
    return set(range(book.appendix_start, len(book.pages)))


def excluded_body_pages(book: Book) -> set:
    """C3 用：前置页 / 附录 / 章导览页 / 章首页 / 册首页 / 末页。"""
    ex = front_set(book) | appendix_set(book)
    ex |= set(book.chapter_intro_pages) | set(book.chapter_pages)
    if book.pages:
        ex.add(0)
        ex.add(len(book.pages) - 1)
    return ex


def excluded_tail_pages(book: Book) -> set:
    """C4 用：再排除"课时末页"——每课时新页起是规范硬要求，末页天然留白。"""
    return excluded_body_pages(book) | book.lesson_end_set


# ----------------------------------------------------------------------------
# C3 只有标题的页
# ----------------------------------------------------------------------------

def check_c3(book: Book) -> Dict[str, Any]:
    if not book.pages:
        return result(False, "PDF 无页面")
    ex = excluded_body_pages(book)
    stats = []
    for p in book.pages:
        stats.append((p, count_chars(body_page_text(book, p))))
    if not stats:
        return result(False, "无可用页面")
    thin = [(p, n) for p, n in stats if p.no not in ex and 0 < n < BODY_MIN_CHARS]
    empty = [(p, n) for p, n in stats if p.no not in ex and n == 0]

    pages = [p.display for p, _ in thin + empty]
    ok = not pages
    checked = len([1 for p, _ in stats if p.no not in ex])
    avg = int(statistics.mean([n for p, n in stats if p.no not in ex])) if checked else 0
    if ok:
        detail = "无正文< %d 字的页（检查 %d 页，平均 %d 字）" % (BODY_MIN_CHARS, checked, avg)
    else:
        detail = "%d 页正文偏少(<%d字): %s（检查 %d 页，平均 %d 字）" % (
            len(pages), BODY_MIN_CHARS,
            ",".join("%dp(%d字)" % (p.display, n) for p, n in (thin + empty)[:10]),
            checked, avg,
        )
    return result(ok, detail, pages=pages, avg_chars=avg, checked=checked)


# ----------------------------------------------------------------------------
# C4 页尾留白
# ----------------------------------------------------------------------------

def check_c4(book: Book) -> Dict[str, Any]:
    if not book.pages:
        return result(False, "PDF 无页面")
    ex = excluded_tail_pages(book)
    threshold = book.content_height * TAIL_GAP_RATIO
    bad = []
    checked = 0
    for p in book.pages:
        if p.no in ex:
            continue
        ls = [l for l in p.lines if (p.footer is None or l is not p.footer) and l.text.strip()]
        if not ls:
            continue
        checked += 1
        last_y = max(l.y1 for l in ls)
        gap = book.content_bottom - last_y
        if gap > threshold:
            bad.append((p.display, gap, gap / book.content_height, p.no))

    # 留白页里有多少是"下一页换板块"造成的（板块分页，非缺陷则主控可放宽）
    block_break = []
    for disp, _, _, no in bad:
        if no + 1 < len(book.pages) and block_head_of(book.pages[no + 1]):
            block_break.append(disp)

    lesson_ends = len([n for n in book.lesson_end_pages if n not in front_set(book)])
    ok = len(bad) <= TAIL_GAP_TOLERANCE
    scope = "检查 %d 页（排除 课时末页 %d 页 / 章导览 %d 页 / 附录 %d 页 / 前置 %d 页）" % (
        checked, lesson_ends, len(book.chapter_intro_pages),
        len(appendix_set(book)), len(front_set(book)),
    )
    if not bad:
        detail = "无异常留白页；%s" % scope
    else:
        detail = "%d 页页尾留白超 %.0f%%：%s；%s%s" % (
            len(bad), TAIL_GAP_RATIO * 100,
            ",".join("%dp(%.0f%%)" % (pg, r * 100) for pg, _, r, _ in bad[:12]),
            scope,
            "；容差 %d 页内" % TAIL_GAP_TOLERANCE if ok else "",
        )
        if block_break:
            detail += "；其中 %d 页的下一页以板块标题起头（板块分页，可人工确认）" % len(block_break)
    return result(ok, detail, pages=[b[0] for b in bad], threshold=threshold,
                  checked=checked, block_break_pages=block_break,
                  lesson_end_pages=[n + 1 for n in book.lesson_end_pages])


# ----------------------------------------------------------------------------
# 公共：课时切分
# ----------------------------------------------------------------------------

def is_appendix_title(name: str) -> bool:
    return any(k in name for k in ("附录", "索引", "知识定位", "目录", "前言", "序言", "后记"))


def split_lessons(book: Book) -> List[Dict[str, Any]]:
    """优先用"本节要点"切出的课时区间；没有再退回按大字号章标题切。"""
    if book.lesson_ranges:
        ranges = book.lesson_ranges
    else:
        starts = sorted(book.chapter_pages)
        ranges = []
        for k, s in enumerate(starts):
            e = starts[k + 1] - 1 if k + 1 < len(starts) else len(book.pages) - 1
            ranges.append((s, e, book.chapter_pages[s]))

    buckets: List[Dict[str, Any]] = []
    for s, e, name in ranges:
        e = min(e, len(book.pages) - 1)
        if s > e:
            continue
        items: List[Tuple[int, Line]] = []
        for i in range(s, e + 1):
            for l in book.pages[i].lines:
                if book.pages[i].footer is not None and l is book.pages[i].footer:
                    continue
                items.append((i, l))
        buckets.append({"name": name, "start": s, "end": e, "items": items})
    return buckets


def locate_sections(items: List[Tuple[int, Line]]) -> Tuple[Optional[int], Optional[int]]:
    p_idx = a_idx = None
    for i, (_, l) in enumerate(items):
        t = l.text.strip()
        if not t or len(t) > 16:
            continue
        if p_idx is None:
            if PRACTICE_RE.match(t) or (t.startswith("练习") and len(t) <= 8):
                p_idx = i
                continue
        if p_idx is not None and a_idx is None and i > p_idx:
            if ANSWER_RE.match(t) or t.startswith("参考答案"):
                a_idx = i
                break
    return p_idx, a_idx


def collect_numbers(items: List[Tuple[int, Line]], a: int, b: int,
                    pat: re.Pattern) -> List[Tuple[int, int]]:
    out: List[Tuple[int, int]] = []
    for i in range(max(a, 0), min(b, len(items))):
        no, l = items[i]
        m = pat.match(l.text)
        if m:
            out.append((int(m.group(1)), no))
    return out


def region_end(items: List[Tuple[int, Line]], start: int, bound: int,
               body_size: float) -> int:
    """题目/答案区间遇到下一节标题就截断，防止把后续小节编号算进来。"""
    bound = min(bound, len(items))
    for i in range(max(start, 0), bound):
        _, l = items[i]
        t = l.text.strip()
        if not t or i == start:
            continue
        if SECTION_RE.match(t):
            return i
        if l.size >= body_size * 1.15 and count_chars(t) >= 2:
            return i
        if PRACTICE_RE.match(t) or ANSWER_RE.match(t):
            return i
    return bound


# ----------------------------------------------------------------------------
# C5 题数 = 答案条数
# ----------------------------------------------------------------------------

def check_c5(book: Book) -> Dict[str, Any]:
    if not book.pages:
        return result(False, "PDF 无页面")
    buckets = split_lessons(book)
    if not buckets:
        return result(False, "未识别到课时（无章标题）")

    mismatched = []
    checked = 0
    for b in buckets:
        if is_appendix_title(b["name"]):
            continue
        p_idx, a_idx = locate_sections(b["items"])
        if p_idx is None:
            continue
        q_stop = region_end(b["items"], p_idx + 1,
                            a_idx if a_idx is not None else len(b["items"]), book.body_size)
        q = collect_numbers(b["items"], p_idx + 1, q_stop, QNUM_RE)
        if not q:
            continue
        checked += 1
        if a_idx is None:
            mismatched.append({"lesson": b["name"], "q": len(q), "a": None,
                               "why": "缺参考答案区", "page": b["start"] + 1})
            continue
        a_stop = region_end(b["items"], a_idx + 1, len(b["items"]), book.body_size)
        a = collect_numbers(b["items"], a_idx + 1, a_stop, ANUM_RE)
        if not a:
            mismatched.append({"lesson": b["name"], "q": len(q), "a": 0,
                               "why": "答案区无编号", "page": b["start"] + 1})
        elif len(q) != len(a):
            mismatched.append({"lesson": b["name"], "q": len(q), "a": len(a),
                               "why": "题数≠答案数", "page": b["start"] + 1})

    if checked == 0:
        return result(True, "未发现练习区（或书籍未生成）", checked=0, mismatched=[])

    ok = not mismatched
    detail = "核对 %d 个课时" % checked
    if ok:
        detail += "，题数与答案条数一致"
    else:
        detail += "，%d 个不一致：" % len(mismatched) + "；".join(
            "%s(%s %s/%s)" % (m["lesson"][:16], m["why"], m["q"], m["a"]) for m in mismatched[:8]
        )
    return result(ok, detail, checked=checked, mismatched=mismatched)


# ----------------------------------------------------------------------------
# C6 题号连续 / 圆点套数字
# ----------------------------------------------------------------------------

def check_c6(book: Book) -> Dict[str, Any]:
    if not book.pages:
        return result(False, "PDF 无页面")
    buckets = split_lessons(book)
    problems = []
    checked = 0
    for b in buckets:
        if is_appendix_title(b["name"]):
            continue
        p_idx, a_idx = locate_sections(b["items"])
        if p_idx is None:
            continue
        q_stop = region_end(b["items"], p_idx + 1,
                            a_idx if a_idx is not None else len(b["items"]), book.body_size)
        q = collect_numbers(b["items"], p_idx + 1, q_stop, QNUM_RE)
        if not q:
            continue
        checked += 1
        nums = [n for n, _ in q]
        dups = sorted({n for n in nums if nums.count(n) > 1})
        expect = list(range(1, len(nums) + 1))
        missing = sorted(set(expect) - set(nums))
        disorder = nums != sorted(nums)
        if dups or missing or disorder:
            problems.append({
                "lesson": b["name"], "page": b["start"] + 1,
                "dups": dups, "missing": missing[:10], "disorder": disorder,
                "seq": nums[:30],
            })

    # 圆点套数字
    bullet = []
    for p in book.pages:
        for l in p.lines:
            if BULLET_NUM_RE.match(l.text):
                bullet.append((p.display, l.text.strip()[:30]))

    ok = not problems and not bullet
    parts = []
    if problems:
        parts.append("%d 个课时题号异常：%s" % (
            len(problems),
            "；".join("%s 重%s 缺%s" % (x["lesson"][:14], x["dups"] or "-", x["missing"] or "-")
                     for x in problems[:6]),
        ))
    if bullet:
        parts.append("%d 处圆点套数字：%s" % (
            len(bullet), ",".join("%dp「%s」" % b for b in bullet[:6])))
    if not parts:
        detail = "%d 个课时题号连续 1..n，无圆点套数字" % checked
    else:
        detail = "；".join(parts)
    return result(ok, detail, checked=checked, lessons=problems, bullets=bullet)


# ----------------------------------------------------------------------------
# C7 图块残留
# ----------------------------------------------------------------------------

def check_c7(book: Book) -> Dict[str, Any]:
    hits, soft = [], []
    for p in book.pages:
        for tok in HARD_TOKENS:
            start = 0
            while True:
                i = p.text.find(tok, start)
                if i < 0:
                    break
                hits.append({"token": tok, "page": p.display,
                             "ctx": snippet(p.text, i, i + len(tok))})
                start = i + len(tok)
        for l in p.lines:
            if SOFT_TOKEN_RE.search(l.text) and re.search(r"[\[\]|()]|^text$", l.text.strip()):
                m = SOFT_TOKEN_RE.search(l.text)
                soft.append({"token": "text", "page": p.display,
                             "ctx": snippet(l.text, m.start(), m.end())})

    if hits or soft:
        sample = "；".join("%s(p%d)「%s」" % (h["token"], h["page"], h["ctx"][:24])
                           for h in (hits + soft)[:6])
        detail = "%d 处残留：%s" % (len(hits) + len(soft), sample)
        return result(False, detail, hits=hits + soft)
    return result(True, "无 mermaid/代码壳残留", hits=[])


# ----------------------------------------------------------------------------
# C8 字符拼化学式
# ----------------------------------------------------------------------------

def formula_bad(line: Line) -> List[str]:
    """同一行内判断命中串的上下标是否真的做了排版。"""
    out = []
    for m in FORMULA_RE.finditer(line.text):
        s = m.group(0)
        if not any(ch.isdigit() for ch in s):
            continue
        chars = line.chars[m.start():m.end()]
        if len(chars) != len(s):
            out.append(s)
            continue
        letters = [c for c in chars if c.c.isalpha()]
        if not letters:
            continue
        base_sz = statistics.median([c.size for c in letters])
        base_oy = statistics.median([c.oy for c in letters])
        bad = False
        for c in chars:
            if not (c.c.isdigit() or c.c in "+-±"):
                continue
            small = base_sz > 0 and c.size <= base_sz * 0.85
            shifted = abs(c.oy - base_oy) >= max(base_sz * 0.18, 1.0)
            if not (small or shifted):
                bad = True
                break
        if bad:
            out.append(s)
    return out


def check_c8(book: Book) -> Dict[str, Any]:
    hits = []
    for p in book.pages:
        for l in p.lines:
            for s in formula_bad(l):
                hits.append({"page": p.display, "text": s,
                             "ctx": l.text.strip()[:40]})
    if hits:
        detail = "%d 处字符拼化学式：%s" % (
            len(hits),
            "；".join("p%d「%s」" % (h["page"], h["text"]) for h in hits[:8]),
        )
        return result(False, detail, hits=hits)
    return result(True, "无字符拼化学式（或上下标已正确排版）", hits=[])


# ----------------------------------------------------------------------------
# C9 章标题位置
# ----------------------------------------------------------------------------

def check_c9(book: Book) -> Dict[str, Any]:
    if not book.pages:
        return result(False, "PDF 无页面")
    skip = set(book.toc_pages) | {0}
    problems = []
    for p in book.pages:
        if p.no in skip:
            continue
        for l in title_candidates(p, book.body_size):
            if count_chars(l.text) < 3:
                continue
            if l.y0 > p.h * 0.25:
                problems.append({"page": p.display, "title": l.text.strip()[:30],
                                 "y": round(l.y0, 1), "h": round(p.h, 1)})
    seen, uniq = set(), []
    for x in problems:
        key = (x["page"], x["title"])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(x)

    if not uniq:
        return result(True, "章标题均在页面顶部 1/5 区域", chapters=len(book.chapter_pages))
    detail = "%d 处大字号标题不在页顶：%s" % (
        len(uniq), "；".join("p%d「%s」(y=%.0f/%.0f)" % (x["page"], x["title"], x["y"], x["h"])
                             for x in uniq[:6]))
    return result(False, detail, problems=uniq, chapters=len(book.chapter_pages))


# ----------------------------------------------------------------------------
# C10 公式残留
# ----------------------------------------------------------------------------

DOLLAR_RE = re.compile(r"(?<!\\)\$[^$\n]{1,120}\$")
PAREN_RE = re.compile(r"\\\((.{1,120}?)\\\)")


def check_c10(book: Book) -> Dict[str, Any]:
    hits = []
    for p in book.pages:
        for m in DOLLAR_RE.finditer(p.text):
            hits.append({"page": p.display, "kind": "$…$", "frag": m.group(0)[:40]})
        for m in PAREN_RE.finditer(p.text):
            hits.append({"page": p.display, "kind": r"\(…\)", "frag": m.group(0)[:40]})
    if hits:
        detail = "%d 处公式残留：%s" % (
            len(hits), "；".join("p%d %s" % (h["page"], h["frag"]) for h in hits[:6]))
        return result(False, detail, hits=hits)
    return result(True, "无 $…$ / \\(…\\) 残留", hits=[])


# ----------------------------------------------------------------------------
# C11 索引（知识定位）
# ----------------------------------------------------------------------------

def check_c11(book: Book) -> Dict[str, Any]:
    """索引条目 词条·点线·页码 → 按页脚页码换算到 PDF 页，再查该页是否含词条。"""
    idx_pages = list(book.index_pages)
    if not idx_pages:
        idx_pages = [p.no for p in book.pages
                     if p.no not in set(book.toc_pages) and "知识定位" in norm(p.text)]
    if not idx_pages:
        return result(True, "未发现「知识定位」附录，跳过", entries=0, fails=[])

    entries: List[Tuple[str, int]] = []
    seen = set()
    for no in idx_pages:
        for l in book.pages[no].lines:
            t = l.text.strip()
            if not t or "知识定位" in t:
                continue
            m = LEADER_RE.match(t) or PLAIN_TAIL_RE.match(t)
            if not m:
                continue
            name = strip_heading(m.group("name"))
            try:
                pg = int(m.group("page"))
            except (TypeError, ValueError):
                continue
            if count_chars(name) < 1 or not (1 <= pg <= 9999):
                continue
            if norm(name) in ("附录二知识定位",):
                continue
            if (norm(name), pg) in seen:
                continue
            seen.add((norm(name), pg))
            entries.append((name, pg))

    if not entries:
        return result(False, "找到「知识定位」附录但没有解析出条目（需人工核对）",
                      entries=0, fails=[], index_pages=[n + 1 for n in idx_pages])

    # 印刷页码 → PDF 页：用页脚抽到的数字建映射，不用固定偏移
    lm = label_map(book.pages)
    fails = []
    for name, pg in entries:
        target = lm.get(pg)
        if target is None:
            fails.append({"name": name, "page": pg, "why": "该印刷页码无对应页", "off": None})
            continue
        if norm(name) not in norm(target.text):
            off = None
            for o in (1, -1, 2, -2, 3, -3):
                cand = lm.get(pg + o)
                if cand is not None and norm(name) in norm(cand.text):
                    off = o
                    break
            fails.append({"name": name, "page": pg, "why": "目标页无此词条",
                          "pdf_page": target.display, "off": off})

    near = len([f for f in fails if f.get("off") in (1, -1)])
    far = len([f for f in fails if f.get("off") is None])
    ok = not fails
    detail = "知识定位 %d 条 / 命中 %d / 失败 %d" % (
        len(entries), len(entries) - len(fails), len(fails))
    if fails:
        detail += "：" + "；".join(
            "%s→p%d%s" % (f["name"][:14], f["page"],
                          ("(实际p%d)" % (f["page"] + f["off"])) if f.get("off") else "")
            for f in fails[:6])
        if near:
            detail += "；%d 条偏差 ±1 页" % near
        if far:
            detail += "；%d 条附近 3 页内查无此词" % far
    return result(ok, detail, entries=len(entries), fails=fails,
                  near_miss=near, far_miss=far,
                  index_pages=[n + 1 for n in idx_pages],
                  label_map_size=len(lm))


# ----------------------------------------------------------------------------
# C12 死链
# ----------------------------------------------------------------------------

DEAD_LINK_PATS = ["![[", "[[", "]]"]


def check_c12(book: Book) -> Dict[str, Any]:
    hits = []
    for p in book.pages:
        for pat in DEAD_LINK_PATS:
            start = 0
            while True:
                i = p.text.find(pat, start)
                if i < 0:
                    break
                # "![[" 里已含 "[[", 避免重复计
                if pat == "[[" and i > 0 and p.text[i - 1] == "!":
                    start = i + len(pat)
                    continue
                hits.append({"token": pat, "page": p.display,
                             "ctx": snippet(p.text, i, i + len(pat))})
                start = i + len(pat)
    if hits:
        detail = "%d 处死链：%s" % (
            len(hits), "；".join("%s(p%d)" % (h["token"], h["page"]) for h in hits[:8]))
        return result(False, detail, hits=hits)
    return result(True, "无 [[ ]] / ![[ 残留", hits=[])


# ----------------------------------------------------------------------------
# C13 单册页数
# ----------------------------------------------------------------------------

def check_c13(book: Book) -> Dict[str, Any]:
    total = len(book.pages)
    ok = 0 < total <= MAX_PAGES
    if total == 0:
        return result(False, "PDF 无页面")
    if ok:
        return result(True, "%d页 ≤ %d" % (total, MAX_PAGES), pages=total)
    return result(False, "%d页 超出上限 %d（建议拆册）" % (total, MAX_PAGES), pages=total)


# ----------------------------------------------------------------------------
# 渲染
# ----------------------------------------------------------------------------

def do_render(doc, spec: str, outdir: str) -> int:
    pages = parse_page_list(spec)
    if not pages:
        sys.stderr.write("--render 未解析出页码: %r\n" % spec)
        return 2
    os.makedirs(outdir, exist_ok=True)
    done = 0
    for n in pages:
        if not (1 <= n <= doc.page_count):
            sys.stderr.write("跳过 p%d（超出 1..%d）\n" % (n, doc.page_count))
            continue
        pix = doc.load_page(n - 1).get_pixmap(dpi=150)
        path = os.path.join(outdir, "p%04d.png" % n)
        pix.save(path)
        print("render p%d -> %s (%dx%d)" % (n, path, pix.width, pix.height))
        done += 1
    print("渲染完成 %d 页 -> %s" % (done, os.path.abspath(outdir)))
    return 0


# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------

def audit(pdf_path: str, out_path: Optional[str]) -> int:
    if not os.path.isfile(pdf_path):
        res = {
            "pdf": pdf_path,
            "pages": 0,
            "error": "PDF 不存在：%s" % pdf_path,
            "checks": {c: {"ok": False, "detail": "PDF 不存在"} for c in CHECK_ORDER},
            "pass": False,
        }
        emit(res)
        write_json(out_path, res)
        return 1

    try:
        doc = fitz.open(pdf_path)
    except Exception as exc:  # noqa: BLE001
        res = {
            "pdf": pdf_path,
            "pages": 0,
            "error": "无法打开 PDF: %s" % exc,
            "checks": {c: {"ok": False, "detail": "无法打开 PDF"} for c in CHECK_ORDER},
            "pass": False,
        }
        emit(res)
        write_json(out_path, res)
        return 1

    pages: List[PageInfo] = []
    try:
        for i in range(doc.page_count):
            pages.append(extract_page(doc, i))
        for p in pages:
            detect_footer(p)
        book = build_book(pages)
    except Exception as exc:  # noqa: BLE001
        doc.close()
        res = {
            "pdf": pdf_path,
            "pages": len(pages),
            "error": "解析失败: %s" % exc,
            "checks": {c: {"ok": False, "detail": "解析失败"} for c in CHECK_ORDER},
            "pass": False,
        }
        emit(res)
        write_json(out_path, res)
        return 1

    checks: Dict[str, Any] = {}
    for cid, fn in (
        ("C1", check_c1), ("C2", check_c2), ("C3", check_c3), ("C4", check_c4),
        ("C5", check_c5), ("C6", check_c6), ("C7", check_c7), ("C8", check_c8),
        ("C9", check_c9), ("C10", check_c10), ("C11", check_c11), ("C12", check_c12),
        ("C13", check_c13),
    ):
        checks[cid] = guard(cid, fn, book)

    passed = all(checks[c]["ok"] for c in HARD_CHECKS)
    res = {
        "pdf": os.path.abspath(pdf_path),
        "pages": len(pages),
        "size_mb": round(os.path.getsize(pdf_path) / 1048576.0, 2),
        "checks": checks,
        "pass": passed,
        "summary": {
            "fail": [c for c in CHECK_ORDER if c in HARD_CHECKS and not checks[c]["ok"]],
            "warn": [c for c in CHECK_ORDER if c not in HARD_CHECKS and not checks[c]["ok"]],
        },
    }
    doc.close()
    emit(res)
    write_json(out_path, res)
    return 0 if passed else 1


def emit(res: Dict[str, Any]) -> None:
    total = res.get("pages", 0)
    print("=" * 68)
    print("PDF: %s" % res.get("pdf"))
    if res.get("error"):
        print("错误: %s" % res["error"])
        print("-" * 68)
        print("FAIL")
        return
    print("页数: %d%s" % (total, ("  体积: %.2f MB" % res["size_mb"]) if "size_mb" in res else ""))
    print("-" * 68)
    for cid in CHECK_ORDER:
        c = res["checks"].get(cid, {"ok": False, "detail": "未执行"})
        if c["ok"]:
            mark = "OK  "
        else:
            mark = "FAIL" if cid in HARD_CHECKS else "WARN"
        print("%-3s %s [%s] %s" % (cid, mark, TITLE.get(cid, ""), c["detail"]))
    print("-" * 68)
    s = res.get("summary") or {}
    if s.get("fail"):
        print("硬性不合格: %s" % " ".join(s["fail"]))
    if s.get("warn"):
        print("警告项: %s" % " ".join(s["warn"]))
    print("PASS" if res.get("pass") else "FAIL")


def write_json(out_path: Optional[str], res: Dict[str, Any]) -> None:
    if not out_path:
        return
    try:
        d = os.path.dirname(os.path.abspath(out_path))
        if d and not os.path.isdir(d):
            os.makedirs(d, exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(res, f, ensure_ascii=False, indent=2)
        print("JSON: %s" % os.path.abspath(out_path))
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write("写 JSON 失败: %s\n" % exc)


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        description="打印稿 PDF 成品验收（C1–C13）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--pdf", required=True, help="待检查的 PDF 路径")
    ap.add_argument("--out", "--json", dest="out", default=None,
                    help="结果 JSON 输出路径（可选）")
    ap.add_argument("--render", default=None,
                    help="渲染页码，如 3,8,12-14（1 基 PDF 页序）")
    ap.add_argument("--dir", dest="outdir", default=None, help="PNG 输出目录")
    args = ap.parse_args(argv)

    if args.render:
        if not args.outdir:
            sys.stderr.write("--render 需配合 --dir\n")
            return 2
        if not os.path.isfile(args.pdf):
            sys.stderr.write("PDF 不存在: %s\n" % args.pdf)
            return 2
        doc = fitz.open(args.pdf)
        try:
            return do_render(doc, args.render, args.outdir)
        finally:
            doc.close()

    return audit(args.pdf, args.out)


if __name__ == "__main__":
    raise SystemExit(main())
