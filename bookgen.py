# -*- coding: utf-8 -*-
"""
把 Obsidian 高中笔记库渲染成可打印的 A4 书。
库只读；成品写到 ~/Desktop/打印本/。
"""
import os, re, sys, argparse, unicodedata, hashlib
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm, mm
from reportlab.lib import colors
from reportlab.lib.colors import HexColor, Color
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_JUSTIFY, TA_CENTER, TA_RIGHT
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (KeepInFrame, BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer,
                                Table, TableStyle, PageBreak, KeepTogether, Flowable,
                                CondPageBreak, NextPageTemplate, HRFlowable)
from reportlab.platypus.tableofcontents import TableOfContents

# 笔记库（只读）与成品输出目录。命令行 --vault / --outdir 会覆盖这里。
VAULT = os.environ.get("NOTES_VAULT") or os.path.expanduser("~/notes")
OUTDIR = os.environ.get("NOTES_OUT") or os.path.expanduser("~/Desktop/打印本")

PW, PH = A4
ML = MR = 72
MT, MB = 64, 62
CW = PW - ML - MR          # 451pt ≈ 15.9cm

# ── 字体 ────────────────────────────────────────────────
# 默认按平台顺序找系统自带中文字体，都不装时用环境变量指定：
#   NOTES_FONT_SONG / NOTES_FONT_SONG_BOLD / NOTES_FONT_HEI / NOTES_FONT_AU / NOTES_FONT_MONO
# 取值 "路径" 或 "路径:face序号"（.ttc 是字体集合，需要给序号）
SONG, HEI, MONO = "Songti", "Heiti", "Menlo"

_FONT_CANDS = {
    "song": [("/System/Library/Fonts/Supplemental/Songti.ttc", 6),
             ("/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc", 0),
             ("/usr/share/fonts/truetype/noto/NotoSerifCJK-Regular.ttc", 0),
             ("/usr/share/fonts/truetype/arphic/uming.ttc", 0),
             ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0),
             ("C:/Windows/Fonts/simsun.ttc", 0)],
    "song_bold": [("/System/Library/Fonts/Supplemental/Songti.ttc", 1),
                  ("/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc", 0),
                  ("/usr/share/fonts/truetype/noto/NotoSerifCJK-Bold.ttc", 0),
                  ("C:/Windows/Fonts/simsun.ttc", 0)],
    "hei": [("/System/Library/Fonts/STHeiti Medium.ttc", 1),
            ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 2),
            ("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", 2),
            ("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", 0),
            ("C:/Windows/Fonts/msyh.ttc", 0)],
    "au": [("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0),
           ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 2),
           ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 0),
           ("C:/Windows/Fonts/msyh.ttc", 0)],
    "mono": [("/System/Library/Fonts/Menlo.ttc", 0),
             ("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 0),
             ("C:/Windows/Fonts/consola.ttf", 0)],
}


def _pick(env, cands):
    v = os.environ.get(env)
    if v:
        path, _, idx = v.rpartition(":")
        if not path:                      # 没写序号
            path, idx = v, ""
        return path, int(idx) if idx.isdigit() else 0
    for path, idx in cands:
        if os.path.exists(path):
            return path, idx
    return None, 0


def _reg(name, env, cands, required=True):
    path, idx = _pick(env, cands)
    if path:
        try:
            pdfmetrics.registerFont(TTFont(name, path, subfontIndex=idx))
            return True
        except Exception as e:
            print("  ! 字体 %s 注册失败（%s）：%s" % (name, path, e))
    if required:
        raise SystemExit(
            "找不到中文字体 %s。请装一款中文宋体，或用环境变量指定，例如：\n"
            "  export %s=/path/to/font.ttc:0" % (name, env))
    return False


_reg(SONG, "NOTES_FONT_SONG", _FONT_CANDS["song"])
_reg("SongtiBold", "NOTES_FONT_SONG_BOLD", _FONT_CANDS["song_bold"])
_reg(HEI, "NOTES_FONT_HEI", _FONT_CANDS["hei"])
_reg("AU", "NOTES_FONT_AU", _FONT_CANDS["au"])
if not _reg(MONO, "NOTES_FONT_MONO", _FONT_CANDS["mono"], required=False):
    MONO = "Courier"
pdfmetrics.registerFontFamily(SONG, normal=SONG, bold="SongtiBold", italic=SONG, boldItalic="SongtiBold")
pdfmetrics.registerFontFamily(HEI, normal=HEI, bold=HEI, italic=HEI, boldItalic=HEI)
FB_CHAIN = (SONG, HEI, "AU")

SUB = dict(zip("₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎", "0123456789+-=()"))
SUP = dict(zip("⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿ", "0123456789+-=()n"))
SUB.update({"ₐ": "a", "ₑ": "e", "ₓ": "x", "ₕ": "h", "ₖ": "k", "ₗ": "l", "ₘ": "m", "ₙ": "n", "ₚ": "p", "ₛ": "s", "ₜ": "t"})

SUBJECT_COLOR = {
    "化学": "#0E6E68", "数学": "#2A4B8D", "物理": "#B35A00", "生物": "#2C6E3F",
    "语文": "#8A2E38", "英语": "#54358C", "政治": "#A8392F", "历史": "#6A4726",
    "地理": "#1B6376",
}
SUBJECT_EDITION = {"化学": "苏教版（2019）", "物理": "人教版（2019）", "生物": "人教版（2019）",
                   "数学": "人教A版（2019）", "语文": "统编版", "英语": "译林版",
                   "政治": "统编版", "历史": "统编版", "地理": "人教版（2019）"}


BUILD = os.path.dirname(os.path.abspath(__file__))


def _load_json(name):
    p = os.path.join(BUILD, "overlays", name)
    if not os.path.exists(p):
        return {}
    import json
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception as e:
        print("  ! %s 读取失败：%s" % (name, e))
        return {}


MERMAID = _load_json("mermaid.json")
FIGS = _load_json("figures.json")
CURRENT = {"subject": ""}


def load_subject_patches(subject):
    """科目级修订：overlays/patches/<科目>.json = [[正则, 替换], ...]"""
    raw = _load_json(os.path.join("patches", subject + ".json"))
    out = []
    for it in raw or []:
        if isinstance(it, (list, tuple)) and len(it) == 2 and isinstance(it[0], str):
            try:
                out.append((re.compile(it[0]), it[1]))
            except re.error as e:
                print("  ! 修订正则无效 %s：%s" % (it[0][:40], e))
    return out


PATCHES_BY_SUBJECT = {}


def tint(c, keep=0.12):
    """c 与白色混合，keep 为保留的色彩比例（越小越淡）。"""
    c = c if isinstance(c, Color) else HexColor(c)
    return Color(c.red * keep + (1 - keep), c.green * keep + (1 - keep),
                 c.blue * keep + (1 - keep))


def has_glyph(font, ch):
    """只有字形 id 非 0 才算真能印——映射到 .notdef 的会印成方框。"""
    try:
        return pdfmetrics.getFont(font).face.charToGlyph.get(ord(ch), 0) != 0
    except Exception:
        return True


# ── 行内标记 ────────────────────────────────────────────
def esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def fb(t, base=None):
    """逐字兜底：宋体 → 黑体 → Arial Unicode。上下标字符固定用 AU（其字形自带升降）。"""
    out, cur = [], None
    for ch in t:
        if not ch.strip():
            out.append(ch); continue
        if ch in SUB and not has_glyph("AU", ch):
            if cur:
                out.append("</font>"); cur = None
            out.append('<sub size="6.6" rise="-3">%s</sub>' % SUB[ch])
            continue
        if ch in SUP and not has_glyph("AU", ch):
            if cur:
                out.append("</font>"); cur = None
            out.append('<super size="6.6" rise="4">%s</super>' % SUP[ch])
            continue
        if ch in SUB or ch in SUP:
            want = "AU"
        elif has_glyph(SONG, ch):
            want = None
        elif has_glyph(HEI, ch):
            want = HEI
        elif has_glyph("AU", ch):
            want = "AU"
        else:
            want = None
        if want != cur:
            if cur:
                out.append("</font>")
            if want:
                out.append('<font name="%s">' % want)
            cur = want
        out.append(ch)
    if cur:
        out.append("</font>")
    return "".join(out)


def subsup(t):
    out, i, n = [], 0, len(t)
    while i < n:
        ch = t[i]
        tbl = SUB if ch in SUB else (SUP if ch in SUP else None)
        if tbl:
            j = i
            buf = []
            while j < n and t[j] in tbl:
                buf.append(tbl[t[j]]); j += 1
            tag = "sub" if tbl is SUB else "super"
            rise = "-3.2" if tag == "sub" else "4.6"
            out.append('<%s size="7.4" rise="%s">%s</%s>' % (tag, rise, "".join(buf), tag))
            i = j
        else:
            out.append(ch); i += 1
    return "".join(out)


LATEX_MAP = [(r"\\times", "×"), (r"\\div", "÷"), (r"\\pm", "±"), (r"\\mp", "∓"),
             (r"\\cdot", "·"), (r"\\leq?", "≤"), (r"\\geq?", "≥"), (r"\\neq", "≠"),
             (r"\\approx", "≈"), (r"\\infty", "∞"), (r"\\rightarrow|\\to", "→"),
             (r"\\leftarrow", "←"), (r"\\Rightarrow", "⇒"), (r"\\angle", "∠"),
             (r"\\triangle", "△"), (r"\\parallel", "∥"), (r"\\perp", "⊥"),
             (r"\\circ", "°"), (r"\\degree", "°"), (r"\\alpha", "α"), (r"\\beta", "β"),
             (r"\\gamma", "γ"), (r"\\theta", "θ"), (r"\\lambda", "λ"), (r"\\mu", "μ"),
             (r"\\pi", "π"), (r"\\rho", "ρ"), (r"\\sigma", "σ"), (r"\\omega", "ω"),
             (r"\\Delta", "Δ"), (r"\\Omega", "Ω"), (r"\\varphi|\\phi", "φ"),
             (r"\\sqrt", "√"), (r"\\sum", "∑"), (r"\\int", "∫"), (r"\\ldots|\\dots", "…"),
             (r"\\%", "%"), (r"\\,|\\;|\\:|\\!|\\quad|\\qquad", " "),
             (r"\\mathrm|\\text|\\mathbf|\\mathit|\\overline|\\vec|\\hat|\\bar", ""),
             (r"\\left|\\right", "")]


def latex_plain(s):
    for pat, rep in LATEX_MAP:
        s = re.sub(pat, rep, s)
    s = s.replace("{", "").replace("}", "").replace("^", "").replace("_", "")
    return s


WIKI = re.compile(r"\[\[([^\]\|]+?)(?:\|([^\]]*))?\]\]")


def _plain(s):
    """不含强调标记的一段：处理双链、转义、字体兜底。"""
    out, pos = [], 0
    for m in WIKI.finditer(s):
        out.append(fb(esc(s[pos:m.start()])))
        tgt = m.group(1).split("#")[0].strip()
        disp = (m.group(2) or tgt).strip()
        out.append(fb(esc(disp)))
        pos = m.end()
    out.append(fb(esc(s[pos:])))
    return "".join(out)


FMT_CACHE = {}
_INLINE_SEQ = [0]


def _xml_safe(s):
    """保留 <super>/<sub>/<font>/<b>/<i> 标签，其余 & < > 转义。"""
    parts = re.split(r"(</?(?:super|sub|font|b|i)(?:\s[^>]*)?>)", s)
    out = []
    for i, pp in enumerate(parts):
        if i % 2 == 1:
            out.append(pp)
        else:
            out.append(pp.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
    return "".join(out)


import html as _html

SYM_FIX = {"ℝ": "R", "ℕ": "N", "ℤ": "Z", "ℚ": "Q", "ℂ": "C", "𝔸": "A",
           "⟶": "→", "⟹": "⇒", "⟸": "⇐", "∖": "\\", "⟨": "〈", "⟩": "〉"}


def _fmt(src):
    if src in FMT_CACHE:
        return FMT_CACHE[src]
    try:
        from latexfmt import to_markup
        m = to_markup(src)
    except Exception:
        m = latex_plain(src)
    m = _html.unescape(m)
    for k, v in SYM_FIX.items():
        m = m.replace(k, v)
    # 公式引擎自带的 <font name="AU"> 不可信（AU 的 ≠ 会印成 #），
    # 一律拆掉，改为逐字按"宋→黑→AU"重新兜底
    m = re.sub(r"</?font[^>]*>", "", m)
    parts = re.split(r"(</?(?:super|sub|b|i)(?:\s[^>]*)?>)", m)
    rebuilt = []
    for i, pp in enumerate(parts):
        if i % 2 == 1:
            rebuilt.append(pp)
        else:
            rebuilt.append(fb(esc(pp)))
    m = _xml_safe("".join(rebuilt))
    FMT_CACHE[src] = m
    return m


def inline(text, base_size=10.8):
    """md 行内 → reportlab 标记。支持 **粗**、==高亮==、[[双链]]、$公式$。"""
    pats = PATCHES_BY_SUBJECT.get(CURRENT.get("subject") or "")
    if pats:
        for rx, rep in pats:
            text = rx.sub(rep, text)
    # 行间公式 $$…$$ 与 \[…\] 先转掉，否则里面的 $…$ 会被当成行内公式切碎
    text = re.sub(r"\$\$(.+?)\$\$", lambda m: _fmt(m.group(1)), text, flags=re.S)
    text = re.sub(r"\\\[(.+?)\\\]", lambda m: _fmt(m.group(1)), text, flags=re.S)
    toks = []
    _cid = _INLINE_SEQ[0]
    _INLINE_SEQ[0] += 1

    # 源笔记里有不少公式没写 $…$，直接留成 \frac{…}{…} 这种裸 LaTeX。
    # 允许出现在中英混排里：从反斜杠命令起，向右吃到括号配平为止。
    def _latex_spans(t):
        spans = []
        dollars = [m.start() for m in re.finditer(r"\$", t)]
        for m in re.finditer(r"\\[a-zA-Z]{2,}", t):
            if any(a <= m.start() < b for a, b in spans):
                continue
            if sum(1 for d in dollars if d < m.start()) % 2 == 1:
                continue          # 落在 $…$ 里，交给行内公式处理，别硬切
            i, depth = m.start(), 0
            while i < len(t):
                ch = t[i]
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth < 0:
                        break
                elif depth == 0 and (re.match(r"[\u4e00-\u9fff]", ch) or ch in "，。；：、！？“”‘’\n（）【】"):
                    break
                i += 1
            j = m.start()
            while j > 0 and re.match(r"[A-Za-z0-9_^)]", t[j - 1]):
                j -= 1
            if t[j:m.start()].strip() or True:
                spans.append((j, i))
        return spans

    if "\\" in text:
        _parts, _last = [], 0
        for a, b in _latex_spans(text):
            if a < _last:
                continue
            _parts.append(text[_last:a])
            toks.append(text[a:b].strip())
            _parts.append("@@F%d_%d@@" % (_cid, len(toks) - 1))
            _last = b
        _parts.append(text[_last:])
        text = "".join(_parts)

    def keep(m):
        toks.append(m.group(1))
        return "@@F%d_%d@@" % (_cid, len(toks) - 1)

    text = re.sub(r"\$([^$]+)\$", keep, text)
    out, pos = [], 0
    for m in re.finditer(r"\*\*(.+?)\*\*|==(.+?)==", text, re.S):
        out.append(_plain(text[pos:m.start()]))
        if m.group(1) is not None:
            out.append("<b>" + _plain(m.group(1)) + "</b>")
        else:
            out.append("<u><b>" + _plain(m.group(2)) + "</b></u>")
        pos = m.end()
    out.append(_plain(text[pos:]))
    res = "".join(out)
    if toks:
        res = re.sub(r"@@F%d_(\d+)@@" % _cid,
                     lambda m: _fmt(toks[int(m.group(1))]), res)
    if "@@F" in res:          # 兜底：宁可少一块公式，也不能把占位符印进书里
        res = re.sub(r"@@F\d+_\d+@@", "", res)
    if "$" in res:            # 剩下没配上对的 $ 是截断留下的，直接去掉
        res = res.replace("$", "")
    return res


# ── 解析 ────────────────────────────────────────────────
class Block:
    def __init__(self, kind, **kw):
        self.kind = kind
        self.__dict__.update(kw)


def parse_front(lines):
    fm = {}
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                return fm, lines[i + 1:]
            m = re.match(r"^([^:：]+)[:：]\s*(.*)$", lines[i])
            if m:
                fm[m.group(1).strip()] = m.group(2).strip()
    return fm, lines


def parse_lesson(path):
    raw = open(path, encoding="utf-8").read().replace("\r\n", "\n")
    lines = raw.split("\n")
    fm, lines = parse_front(lines)
    title = os.path.basename(path)[:-3]
    m = re.match(r"^(?:第?(\d+)[\s\.、]?)\s*(.*)$", title)
    order = m.group(1) if m else ""
    name = m.group(2).strip() if m else title

    lead = ""
    sections, answers, cards = [], [], []
    cur = None
    i, n = 0, len(lines)
    while i < n:
        ln = lines[i]
        s = ln.strip()
        if not s:
            i += 1; continue
        if s.startswith("# ") and not title.strip("# "):
            i += 1; continue
        if s.startswith("## "):
            if "复习卡" in s:
                j = i + 1
                while j < n and not lines[j].strip().startswith("## "):
                    t2 = lines[j].strip()
                    if "::" in t2 and not t2.startswith("#"):
                        q, a = t2.split("::", 1)
                        q = re.sub(r"^[-*]\s*", "", q).strip()
                        if q and a.strip():
                            cards.append((q, a.strip()))
                    j += 1
            break
        if s == "#flashcards":
            i += 1; continue
        cm_ = re.match(r"^>\s*\[!(\w+)\]\s*(.*)$", s)
        if cm_:
            cur = {"kind": cm_.group(1), "label": cm_.group(2).strip(), "blocks": []}
            sections.append(cur)
            i += 1; continue
        if s.startswith(">"):
            body = re.sub(r"^>\s?", "", s)
            if cur is None:
                if lead:
                    lead += body
                else:
                    lead = body
                i += 1; continue
            # 收集同类行
            if body.startswith("```mermaid"):
                j, code = i + 1, []
                while j < n:
                    b2 = re.sub(r"^>\s?", "", lines[j].strip())
                    if b2.startswith("```"):
                        break
                    code.append(b2)
                    j += 1
                # 留着源码：没有 overlay 时靠它抽节点排兜底图，不留就是一张空图
                cur["blocks"].append(Block("mermaid", text="\n".join(code)))
                i = j + 1; continue
            if body.startswith("```"):
                fence, j = body[:3], i + 1
                code = []
                while j < n:
                    b2 = re.sub(r"^>\s?", "", lines[j].strip())
                    if b2.startswith("```"):
                        break
                    code.append(b2)
                    j += 1
                cur["blocks"].append(Block("code", text="\n".join(code)))
                i = j + 1; continue
            mi = re.match(r"^!\[\[([^\]]+)\]\]", body)
            if mi:
                cur["blocks"].append(Block("img", name=mi.group(1)))
                i += 1; continue
            if body.startswith("|"):
                rows = [body]
                j = i + 1
                while j < n:
                    b2 = re.sub(r"^>\s?", "", lines[j].strip())
                    if not b2.startswith("|"):
                        break
                    rows.append(b2); j += 1
                cur["blocks"].append(Block("table", rows=rows))
                i = j; continue
            if re.match(r"^#{3,4}\s", body):
                cur["blocks"].append(Block("h3", text=re.sub(r"^#{3,4}\s*", "", body)))
                i += 1; continue
            if re.match(r"^\d+\.\s", body):
                cur["blocks"].append(Block("li", text=re.sub(r"^\d+\.\s*", "", body), ordered=True))
                i += 1; continue
            if re.match(r"^[-*]\s", body):
                cur["blocks"].append(Block("li", text=re.sub(r"^[-*]\s*", "", body), ordered=False))
                i += 1; continue
            if "本节要点" in (cur["label"] or "") and ("下一节" in body or "上一节" in body):
                i += 1; continue
            if body.strip() in ("**参考答案**", "参考答案"):
                j = i + 1
                while j < n:
                    b2 = re.sub(r"^>\s?", "", lines[j].strip())
                    if b2.startswith("#") or b2.startswith("```"):
                        break
                    if b2:
                        t2 = b2
                        t2 = re.sub(r"^[-*]\s*", "", t2)
                        mnum = re.match(r"^(\d+)\s*[.、．]\s*(.*)$", t2)
                        if mnum:
                            answers.append({"num": int(mnum.group(1)), "text": mnum.group(2).strip()})
                        elif answers:
                            answers[-1]["text"] += " " + t2.strip()
                        else:
                            answers.append({"num": None, "text": t2.strip()})
                    j += 1
                i = j; continue
            cur["blocks"].append(Block("p", text=body))
            i += 1; continue
        i += 1
    return prune_lesson({"path": path, "fm": fm, "title": name, "order": order,
                         "fname": os.path.basename(path)[:-3],
                         "lead": lead, "sections": sections, "answers": answers,
                         "cards": cards})


SECTION_ORDER = ["summary", "note", "abstract", "example", "important", "warning", "tip", "question"]


# ── 修订层：订正原文的事实错误，去掉模板腔 ──────────────
PATCHES = [
    # ① NaHSO₄ 的名称
    (r"NaHSO₄ 名称里没有氢字，却是酸式盐。",
     "NaHSO₄ 是硫酸氢钠，硫酸氢根中含有可电离的氢，属于酸式盐。"),
    # ② 多元酸的范围
    (r"酸按电离出的氢离子数目分：只电离出一个 H⁺ 的是一元酸（HCl、CH₃COOH），两个的是二元酸（H₂SO₄、H₂CO₃），三个及以上的是多元酸（H₃PO₄）。",
     "按每个酸分子可电离出 H⁺ 的数目，可分为一元酸、二元酸、三元酸等：HCl 是一元酸，H₂SO₄ 是二元酸，H₃PO₄ 是三元酸；二元酸、三元酸等统称多元酸。"),
    # ③ 氯气与水：可逆号
    (r"Cl₂ \+ H₂O = H⁺ \+ Cl⁻ \+ HClO", "Cl₂ + H₂O ⇌ H⁺ + Cl⁻ + HClO"),
    # ④ 铜与浓硫酸：写清加热条件，删掉「常温钝化」
    (r"Cu \+ 2H₂SO₄\(浓\) = CuSO₄", "Cu + 2H₂SO₄(浓) =△= CuSO₄"),
    (r"常温钝化，加热才反应", "需加热；产物为 SO₂，不放出 H₂"),
    # ④ 烷烃编号：取代基位次升序排列，逐项比较，不用「位次之和」
    (r"从两端分别编号，比较取代基位次，取最近端与位次和较小的方向",
     "从两端分别编号，把取代基位次按由小到大排列，逐项比较，第一个不同处较小者优先"),
    (r"编号两端比较位次，最近端优先，位次和较小者优先。",
     "编号时从两端各排一次，把取代基位次按由小到大排列后逐项比较，第一个不同的数较小者优先。"),
    (r"编号取取代基最近端、位次和较小者",
     "编号把取代基位次升序排列、逐项比较，第一个不同处较小者优先"),
    (r"取代基位次之和尽可能小",
     "把取代基位次升序排列、逐项比较，第一个不同处较小者优先"),
    (r"取位次之和较小的\[\[编号方向\]\]",
     "把取代基位次升序排列、逐项比较，第一个不同处较小者优先"),
    (r"取位次之和较小的编号方向",
     "把取代基位次升序排列、逐项比较，第一个不同处较小者优先"),
    (r"取最近端与位次和较小的方向",
     "把两端的取代基位次分别按由小到大排列，逐项比较，第一个不同处较小者优先"),
    (r"两端等距时比较位次之和",
     "两端等距时把位次升序排列、逐项比较，第一个不同处较小者优先"),
    (r"两端等距时取位次之和较小的方向",
     "两端等距时把位次升序排列、逐项比较，第一个不同处较小者优先"),
    (r"从两端分别编号，把取代基位次按由小到大排列，逐项比较，第一个不同处较小者优先",
     "从两端分别编号，把取代基位次按由小到大排列，逐项比较，第一个不同处较小者优先"
     "（例如 2,3,5,8 优先于 2,4,5,7，虽然两组总和相同）"),
    # ⑤ 烯炔编号：双键、三键位次合并比较，仍相同则双键优先
    (r"编号使不饱和键位次总和尽可能小",
     "编号把双键与三键的位次合在一起，按由小到大排列后逐项比较；仍相同时给双键较低的位次；"
     "多重键的位次与种类仍无法区分时，再比较取代基位次"),
    (r"先保证不饱和键位次最小",
     "先把双键、三键的位次合起来比较，取较小的一组"),
    (r"先让不饱和键位次最小",
     "先把双键、三键的位次合起来比较，取较小的一组"),
    (r"编号先使双键或三键位次最小",
     "编号先把双键、三键的位次合起来比较，仍相同时双键优先"),
    (r"使不饱和键的位次最小",
     "使双键、三键的位次合在一起比较时最小"),
    # ⑥ 原电池：材料不必不同
    (r"两个活泼性不同的==电极==",
     "两个能分别发生氧化、还原的==电极==（材料通常不同，浓差电池可用同种材料）"),
    (r"两个活泼性不同的电极",
     "两个能分别发生氧化、还原的电极（材料通常不同，浓差电池可用同种材料）"),
    (r"构成四件事：两极不同", "构成四件事：两个电极（材料可同）"),
    (r"原电池的构成条件有哪些？::两个不同电极",
     "原电池的构成条件有哪些？::两个电极（材料可相同，浓差电池即如此）"),
    (r"存在能自发进行的\[\[氧化还原\]\]反应。",
     "存在能自发进行的[[氧化还原]]反应。电极材料不必不同：浓差电池两极材料相同，靠两侧离子浓度差产生电动势。"),
    (r"能自发进行氧化还原反应。盐桥",
     "能自发进行氧化还原反应；电极材料不必不同，浓差电池两极材料相同，靠浓度差产生电动势。盐桥"),
    (r"若两组位次相同，优先给双键较低位次。",
     "若两组位次相同，优先给双键较低位次；仍无法区分时再比较取代基位次。"),
    # ⑦ 焓变：加热条件不等于吸热
    (r"反例要单独记住：需要加热或高温的反应不一定是吸热反应，需要持续加热维持的反应才多为吸热；放热反应开始时也可能要先加热引发。",
     "反例要单独记住：需要加热或高温的反应不一定是吸热反应。在给定条件下，ΔH > 0 为吸热，"
     "ΔH < 0 为放热；反应是否需要加热与反应焓变的正负是两个不同的问题。放热反应开始时也可能要先加热引发。"),
    # ⑧ 检验 SO₂ 与 Cl₂：避免两个正确选项
    (r"A\. 是否使湿润的淀粉碘化钾试纸变蓝", "A. 是否能使湿润的蓝色石蕊试纸变红"),
    (r"4\. B。两者都能使品红褪色，但只有 SO₂ 加热后颜色复原。",
     "4. B。两者都能使品红褪色，但只有 SO₂ 加热后颜色复原。两种气体溶于水都显酸性，"
     "都能使蓝色石蕊试纸变红，A 不能区分。"),
    # ⑨ 醇的通式适用范围
    (r"5\. 通式为 CₙH₂ₙ₊₁OH；乙二醇含两个羟基，属于二元醇。",
     "5. 饱和链状一元醇的通式为 CₙH₂ₙ₊₁OH；乙二醇含两个羟基，属于二元醇。"),
]

DROP_SENT = [
    r"高考中主要出现在", r"在高考中主要考", r"是选择题的固定考点", r"常出现在大题的前一问",
    r"几乎每年", r"属于必须记住的内容", r"下面这几张表", r"复习安排按当天",
    r"本课时长约", r"建议用时",
]

SENT_SPLIT = re.compile(r"(?<=[。！？])")


def fix_text(t):
    for pat, rep in PATCHES:
        t = re.sub(pat, rep, t)
    subj = CURRENT.get("subject")
    if subj:
        for pat, rep in PATCHES_BY_SUBJECT.get(subj, ()):
            t = pat.sub(rep, t)
    return t


def _norm_sent(s):
    return re.sub(r"[^\u4e00-\u9fa5A-Za-z0-9]", "", s)


def clean_prose(t, seen):
    """删掉报幕句、无依据的高考频率判断，以及本课内重复的句子。"""
    t = fix_text(t)
    # 断句不能切在 $...$ 里，否则公式会碎成两半、$ 也配不上对
    t = re.sub(r"\$[^$]*\$", lambda m: m.group(0).replace("。", "\x03"), t)
    out = []
    for sent in SENT_SPLIT.split(t):
        if not sent.strip():
            continue
        if any(re.search(p, sent) for p in DROP_SENT):
            continue
        key = _norm_sent(sent)
        if len(key) >= 16 and key in seen:
            continue
        if len(key) >= 16:
            seen.add(key)
        out.append(sent)
    return "".join(out).replace("\x03", "。").strip()


def prune_lesson(ls):
    """按内容裁剪：去掉空节、模板复习段，合并同课重复的句子。"""
    seen, keep = set(), []
    if ls["lead"]:
        ls["lead"] = clean_prose(ls["lead"], seen)
    for sec in ls["sections"]:
        blocks = []
        for b in sec["blocks"]:
            if b.kind in ("p", "li"):
                t = clean_prose(b.text, seen)
                if not _norm_sent(t):
                    continue
                b.text = t
            elif b.kind == "table":
                b.rows = [fix_text(r) for r in b.rows]
            blocks.append(b)
        sec["blocks"] = blocks
        if not blocks:
            continue
        if sec["kind"] == "tip":
            sec["label"] = "记忆要点"
        keep.append(sec)
    ls["sections"] = keep
    for a in ls["answers"]:
        a["text"] = fix_text(a["text"])
    ls["cards"] = [(fix_text(q), fix_text(a)) for q, a in ls["cards"]]
    return ls


def scan_subject(subject):
    root = os.path.join(VAULT, subject)
    vols = []
    for v in sorted(os.listdir(root)):
        vd = os.path.join(root, v)
        if not os.path.isdir(vd) or v.startswith("."):
            continue
        chapters = []
        for c in sorted(os.listdir(vd)):
            cd = os.path.join(vd, c)
            if not os.path.isdir(cd) or c.startswith("."):
                continue
            units = []
            subs = [d for d in sorted(os.listdir(cd)) if os.path.isdir(os.path.join(cd, d)) and d != "知识点"]
            if subs and all(os.path.isdir(os.path.join(cd, s, "知识点")) or
                            any(f.endswith(".md") for f in os.listdir(os.path.join(cd, s)))
                            for s in subs):
                for u in subs:
                    ud = os.path.join(cd, u)
                    les = [os.path.join(ud, f) for f in sorted(os.listdir(ud)) if f.endswith(".md")]
                    if les:
                        units.append({"name": u, "lessons": les})
                if units:
                    chapters.append({"name": c, "units": units})
                    continue
            les = [os.path.join(cd, f) for f in sorted(os.listdir(cd)) if f.endswith(".md")]
            if les:
                chapters.append({"name": c, "units": [{"name": "", "lessons": les}]})
        if chapters:
            vols.append({"name": v, "chapters": chapters})
    return vols


def _section_text(md, head):
    m = re.search(r"##\s*%s\s*\n(.*?)(?=\n##\s|\Z)" % head, md, re.S)
    if not m:
        return ""
    txt = m.group(1)
    txt = re.sub(r"^>\s?", "", txt, flags=re.M)
    txt = re.sub(r"[*`>]", "", txt)
    txt = re.sub(r"\n{2,}", "\n", txt)
    return txt.strip()


def _clip(t, limit=150):
    t = re.sub(r"\s+", "", t)
    if len(t) <= limit:
        return t
    cut = max(t.rfind("。", 0, limit), t.rfind("；", 0, limit))
    if cut >= 40:
        return t[:cut + 1]
    return t[:limit] + "…"


def scan_terms(subject):
    """词条：一句话定义 + 第一段讲解；课时取自 front matter 的「课时」。"""
    root = os.path.join(VAULT, subject)
    out = []
    for v in sorted(os.listdir(root)):
        vd = os.path.join(root, v)
        if not os.path.isdir(vd):
            continue
        for dp, dn, fn in sorted(os.walk(vd)):
            if not dp.endswith("知识点"):
                continue
            for f in sorted(fn):
                if not f.endswith(".md"):
                    continue
                p = os.path.join(dp, f)
                txt = open(p, encoding="utf-8").read()
                fm, body = parse_front(txt.split("\n"))
                md = "\n".join(body)
                defn = _section_text(md, "一句话定义").split("\n")[0].strip()
                expl = _clip(_section_text(md, "讲解"), 150)
                if not defn:
                    continue
                lesson = fm.get("课时", "")
                out.append({"name": f[:-3], "def": defn, "expl": expl,
                            "vol": v, "chapter": fm.get("专题") or fm.get("章") or fm.get("课") or "",
                            "unit": fm.get("单元", ""), "lesson": lesson})
    return out


# ── 样式 ────────────────────────────────────────────────
class S:
    pass

def make_styles(color):
    s = S()
    s.body = ParagraphStyle("body", fontName=SONG, fontSize=10.8, leading=18.3,
                            alignment=TA_LEFT, wordWrap="CJK", spaceAfter=5,
                            firstLineIndent=21.6, textColor=HexColor("#1A1A1A"))
    s.lead = ParagraphStyle("lead", parent=s.body, fontSize=10.3, leading=17.6,
                            textColor=HexColor("#3D3D3D"), spaceAfter=0)
    s.h3 = ParagraphStyle("h3", fontName=HEI, fontSize=11.4, leading=17,
                          spaceBefore=9, spaceAfter=4, textColor=HexColor("#111111"))
    s.li = ParagraphStyle("li", parent=s.body, leftIndent=15, firstLineIndent=-15,
                          spaceAfter=2.6)
    s.cell = ParagraphStyle("cell", fontName=SONG, fontSize=8.7, leading=12.6,
                            wordWrap="CJK", textColor=HexColor("#1A1A1A"))
    s.cellh = ParagraphStyle("cellh", parent=s.cell, fontName=HEI, fontSize=8.7,
                             textColor=HexColor("#222222"))
    s.caption = ParagraphStyle("cap", fontName=SONG, fontSize=8.6, leading=13,
                               alignment=TA_CENTER, textColor=HexColor("#5A5A5A"),
                               wordWrap="CJK", spaceBefore=1, spaceAfter=8)
    s.ans = ParagraphStyle("ans", parent=s.body, fontSize=9.0, leading=14.6,
                           textColor=HexColor("#2A2A2A"), leftIndent=13, firstLineIndent=-13)
    # 答案三层：结论（加粗顶格）／解析（缩进小字浅灰）／得分点（再缩进）
    s.a1 = ParagraphStyle("a1", fontName=SONG, fontSize=9.6, leading=14.2,
                          textColor=HexColor("#101010"), leftIndent=0,
                          firstLineIndent=0, spaceBefore=3, spaceAfter=1,
                          wordWrap="CJK")
    s.a2 = ParagraphStyle("a2", fontName=SONG, fontSize=8.8, leading=13.2,
                          textColor=HexColor("#5C5C5C"), leftIndent=13,
                          firstLineIndent=0, spaceAfter=1, wordWrap="CJK")
    s.a3 = ParagraphStyle("a3", fontName=SONG, fontSize=8.8, leading=13.2,
                          textColor=HexColor("#3A3A3A"), leftIndent=24,
                          firstLineIndent=0, spaceAfter=1, wordWrap="CJK")
    s.tag = ParagraphStyle("tag", fontName=HEI, fontSize=8.2, leading=12,
                           textColor=HexColor("#6E6E6E"), spaceBefore=5,
                           spaceAfter=2, wordWrap="CJK")
    s.cardans = ParagraphStyle("cardans", fontName=SONG, fontSize=8.4, leading=12.8,
                               textColor=HexColor("#5C5C5C"), wordWrap="CJK",
                               leftIndent=13, firstLineIndent=-13, spaceAfter=2)
    s.tocv = ParagraphStyle("tocv", fontName=HEI, fontSize=13.5, leading=22)
    s.toch = ParagraphStyle("toch", fontName=HEI, fontSize=10.6, leading=19)
    s.tocu = ParagraphStyle("tocu", fontName=SONG, fontSize=10.2, leading=18)
    s.tocl = ParagraphStyle("tocl", fontName=SONG, fontSize=9.6, leading=17)
    s.term = ParagraphStyle("term", fontName=HEI, fontSize=9.2, leading=13.6,
                            wordWrap="CJK")
    s.termb = ParagraphStyle("termb", fontName=SONG, fontSize=8.5, leading=12.4,
                             wordWrap="CJK", textColor=HexColor("#222222"))
    s.termx = ParagraphStyle("termx", fontName=SONG, fontSize=7.9, leading=11.6,
                             wordWrap="CJK", textColor=HexColor("#5A5A5A"))
    return s


class SectionHead(Flowable):
    def __init__(self, label, color, width=CW):
        Flowable.__init__(self)
        self.label, self.color, self.w = label, HexColor(color), width

    def wrap(self, aw, ah):
        self.width, self.height = aw, 24
        return aw, 24

    def draw(self):
        c = self.canv
        top = self.height - 5
        c.setFillColor(self.color)
        c.rect(0, top - 11.5, 2.6, 12, stroke=0, fill=1)
        c.setFont(HEI, 10.4)
        c.setFillColor(self.color)
        c.drawString(8.5, top - 9.6, self.label)
        wl = pdfmetrics.stringWidth(self.label, HEI, 10.4)
        c.setStrokeColor(HexColor("#D5D5D5"))
        c.setLineWidth(0.5)
        c.line(8.5 + wl + 9, top - 4.2, self.width, top - 4.2)


class Head(Flowable):
    """学册 / 专题 / 单元 / 课时 标题，同时抛书签与目录项。"""

    def __init__(self, text, level, color, sub="", key="", toc_text=None, note=""):
        Flowable.__init__(self)
        self.text, self.level, self.color = text, level, HexColor(color)
        self.sub, self.key, self.toc_text, self.note = sub, key, toc_text or text, note
        self.h = {0: 104, 1: 62, 2: 40, 3: 52}[level]

    def wrap(self, aw, ah):
        self.width, self.height = aw, self.h
        return aw, self.h

    def draw(self):
        c = self.canv
        if self.key:
            c.bookmarkPage(self.key)
            c.addOutlineEntry(self.text, self.key,
                              level=(0 if self.level <= 1 else 1), closed=False)
        if self.level == 0:
            c.setFillColor(self.color)
            c.rect(0, 0, self.width, self.height - 14, stroke=0, fill=1)
            c.setFillColor(colors.white)
            c.setFont(HEI, 21)
            c.drawString(20, self.height - 52, self.text)
            c.setFont(HEI, 9.6)
            c.setFillColor(Color(1, 1, 1, 0.78))
            c.drawString(21, self.height - 74, self.sub)
        elif self.level == 1:
            c.setFont(HEI, 8.8)
            c.setFillColor(self.color)
            if self.note:
                c.drawString(0, 47, self.note)
            c.setFont(HEI, 17.5)
            c.setFillColor(HexColor("#141414"))
            c.drawString(0, 22, self.text)
            c.setStrokeColor(self.color)
            c.setLineWidth(1.6)
            c.line(0, 12, self.width, 12)
        elif self.level == 2:
            c.setFillColor(self.color)
            c.rect(0, 15, 2.4, 11, stroke=0, fill=1)
            c.setFont(HEI, 12.4)
            c.setFillColor(HexColor("#1A1A1A"))
            c.drawString(8, 17, self.text)
            wl = pdfmetrics.stringWidth(self.text, HEI, 12.4)
            c.setStrokeColor(HexColor("#DCDCDC"))
            c.setLineWidth(0.5)
            c.line(8 + wl + 8, 20.5, self.width, 20.5)
        else:
            if self.note:
                c.setFont(HEI, 8.6)
                c.setFillColor(self.color)
                c.drawString(0, 39, self.note)
            c.setFont(HEI, 14.6)
            c.setFillColor(HexColor("#101010"))
            c.drawString(0, 20, self.text)
            wl = pdfmetrics.stringWidth(self.text, HEI, 14.6)
            c.setStrokeColor(self.color)
            c.setLineWidth(0.9)
            c.line(0, 13.5, min(self.width, wl + 26), 13.5)


def is_wide(ch):
    return unicodedata.east_asian_width(ch) in ("W", "F", "A")


class AsciiFigure(Flowable):
    def __init__(self, text, color="#888888", maxw=CW, size=10.2):
        Flowable.__init__(self)
        self.lines = text.split("\n")
        self.color = HexColor(color)
        self.maxw, self.size = maxw, size

    @staticmethod
    def _cells(line):
        return sum(1 if (c in SUB or c in SUP) else (2 if is_wide(c) else 1) for c in line)

    def wrap(self, aw, ah):
        self.width = aw
        cols = max((self._cells(l) for l in self.lines), default=8)
        self.cell = min(self.size * 0.5, (aw - 24) / max(cols, 1))
        self.fs = self.cell * 2
        self.lh = self.fs * 1.16
        self.height = len(self.lines) * self.lh + 12
        return aw, self.height

    def draw(self):
        c = self.canv
        c.saveState()
        # 左侧细引导线代替灰底
        c.setStrokeColor(self.color)
        c.setLineWidth(1.6)
        c.line(0.8, 4, 0.8, self.height - 4)
        c.setFillColor(HexColor("#1E1E1E"))
        y = self.height - 7 - self.fs * 0.84
        for line in self.lines:
            x = 12
            for ch in line:
                sub = ch in SUB or ch in SUP
                w = 1 if sub else (2 if is_wide(ch) else 1)
                fnt = HEI if w == 2 else MONO
                if ch.strip() and not has_glyph(fnt, ch):
                    fnt = "AU" if has_glyph("AU", ch) else HEI
                sz = self.fs if w == 2 else self.fs * 0.88
                if sub:
                    ch2 = SUB.get(ch) or SUP.get(ch) or ch
                    c.setFont(SONG, sz * 0.72)
                    c.setFillColor(HexColor("#1E1E1E"))
                    c.drawString(x + 0.4, y - (2.2 if ch in SUB else -3.2), ch2)
                    x += w * self.cell
                    continue
                try:
                    sw = pdfmetrics.stringWidth(ch, fnt, sz)
                except Exception:
                    sw = 0
                if ch.strip():
                    c.setFont(fnt, sz)
                    c.drawString(x + (w * self.cell - sw) / 2, y, ch)
                x += w * self.cell
            y -= self.lh
        c.restoreState()


IMG_CACHE = {}


def subject_of(ls):
    return ls.get("fm", {}).get("科目", "")


def find_asset(name, subject=""):
    if name in IMG_CACHE:
        return IMG_CACHE[name]
    cands = [os.path.join(VAULT, "附件", subject, name), os.path.join(VAULT, "附件", name)]
    for c in cands:
        if os.path.exists(c):
            IMG_CACHE[name] = c
            return c
    hit = None
    for dp, dn, fn in os.walk(os.path.join(VAULT, "附件")):
        if name in fn:
            hit = os.path.join(dp, name); break
    IMG_CACHE[name] = hit
    return hit


def load_image(name, subject, avail):
    from reportlab.platypus import Image as RLImage
    p = find_asset(name, subject)
    if not p:
        return None
    try:
        im = RLImage(p)
        iw, ih = im.imageWidth, im.imageHeight
        sc = min(1.0, avail / iw, 215.0 / ih)
        im.drawWidth, im.drawHeight = iw * sc, ih * sc
        im.hAlign = "CENTER"
        return im
    except Exception:
        return None


def split_row(line):
    # 公式里的 | 是绝对值/条件竖线，不是列分隔符，先藏起来
    line = re.sub(r"\$[^$]*\$", lambda m: m.group(0).replace("|", "\x02"), line.strip())
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    parts = re.split(r"(?<!\\)\|", line)
    return [p.replace("\\|", "|").replace("\x02", "|").strip() for p in parts]


def make_table(rows, color, styles, avail=CW):
    color = HexColor(color)
    data = [split_row(r) for r in rows]
    data = [r for r in data if not all(re.fullmatch(r":?-{2,}:?", c or "") for c in r)]
    if not data:
        return None
    ncol = max(len(r) for r in data)
    data = [r + [""] * (ncol - len(r)) for r in data]
    head, body = data[0], data[1:]
    def dw(t):
        return sum(2 if is_wide(ch) else 1 for ch in t)
    weights = []
    for i in range(ncol):
        m = max([dw(head[i])] + [dw(r[i]) for r in body] or [8])
        weights.append(max(8, min(m, 60)))
    tot = sum(weights)
    widths = [avail * w / tot for w in weights]
    cells = [[Paragraph(inline(c), styles.cellh) for c in head]]
    for r in body:
        cells.append([Paragraph(inline(c), styles.cell) for c in r])
    t = Table(cells, colWidths=widths, repeatRows=1, hAlign="LEFT")
    st = [
        ("BACKGROUND", (0, 0), (-1, 0), tint(color, 0.13)),
        ("LINEBELOW", (0, 0), (-1, 0), 0.7, HexColor("#8C8C8C")),
        ("LINEBELOW", (0, 1), (-1, -2), 0.35, HexColor("#D8D8D8")),
        ("BOX", (0, 0), (-1, -1), 0.6, HexColor("#A8A8A8")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 3.4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.6),
        ("LEFTPADDING", (0, 0), (-1, -1), 4.4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4.4),
    ]
    t.setStyle(TableStyle(st))
    return t



class IndexLine(Flowable):
    """索引条目：词条（黑体）＋出处（小灰）＋点线＋页码，整行可被检索。"""

    def __init__(self, name, loc, page, color, width=CW):
        Flowable.__init__(self)
        self.name, self.loc, self.page = name, loc, page
        self.color, self.w = HexColor(color), width

    def wrap(self, aw, ah):
        self.width = aw
        self.height = 14.2
        return aw, self.height

    def draw(self):
        c = self.canv
        base = 4.0
        nm = self.name
        c.setFont(HEI, 8.8)
        c.setFillColor(HexColor("#1A1A1A"))
        c.drawString(0, base, nm)
        x = pdfmetrics.stringWidth(nm, HEI, 8.8) + 6
        if self.loc:
            c.setFont(SONG, 7.4)
            c.setFillColor(HexColor("#6E6E6E"))
            c.drawString(x, base, self.loc)
            x += pdfmetrics.stringWidth(self.loc, SONG, 7.4) + 5
        num = str(self.page) if self.page else "—"
        c.setFont(SONG, 8.4)
        nw = pdfmetrics.stringWidth(num, SONG, 8.4)
        x1 = self.width - nw - 2
        if x1 > x + 6:
            unit = pdfmetrics.stringWidth("· ", SONG, 7.4) or 3.8
            nrep = int((x1 - x) / unit)
            if nrep >= 2:
                c.setFont(SONG, 7.4)
                c.setFillColor(HexColor("#A8A8A8"))
                c.drawString(x, base + 0.4, "· " * nrep)
        c.setFont(SONG, 8.4)
        c.setFillColor(HexColor("#333333"))
        c.drawRightString(self.width - 2, base, num)
        c.setStrokeColor(HexColor("#EDEDED"))
        c.setLineWidth(0.3)
        c.line(0, 0.4, self.width, 0.4)


class TocLine(Flowable):
    def __init__(self, text, page, level, color, width=CW):
        Flowable.__init__(self)
        self.text, self.page, self.level = text, page, level
        self.color, self.w = HexColor(color), width
        self.h = {0: 34, 1: 23, 2: 20, 3: 18}[level]

    def wrap(self, aw, ah):
        self.width = aw
        return aw, self.h

    def draw(self):
        c = self.canv
        lv = self.level
        ind = {0: 0, 1: 2, 2: 15, 3: 32}[lv]
        font = HEI if lv <= 1 else SONG
        size = {0: 12.0, 1: 10.4, 2: 9.8, 3: 9.4}[lv]
        base = self.h - (24 if lv == 0 else 15)
        if lv == 0:
            c.setFillColor(tint(self.color, 0.08))
            c.rect(0, base - 6, self.width, 24, stroke=0, fill=1)
            c.setFillColor(self.color)
        else:
            c.setFillColor(HexColor("#1A1A1A") if lv < 3 else HexColor("#333333"))
        c.setFont(font, size)
        c.drawString(ind + 4, base, self.text)
        tw = pdfmetrics.stringWidth(self.text, font, size)
        num = str(self.page) if self.page else "－"
        nw = pdfmetrics.stringWidth(num, font, size)
        x0, x1 = ind + 4 + tw + 7, self.width - nw - 6
        if x1 > x0:
            # 真引导符：用点字排出来，既能被检索，印出来也是常规的点线
            unit = pdfmetrics.stringWidth("· ", SONG, 7.6) or 4.0
            nrep = int((x1 - x0) / unit)
            if nrep >= 2:
                c.setFont(SONG, 7.6)
                c.setFillColor(HexColor("#9A9A9A"))
                c.drawString(x0, base + 1.0, "· " * nrep)
        c.setFillColor(self.color if lv <= 1 else HexColor("#333333"))
        c.setFont(font, size)
        c.drawRightString(self.width - 2, base, num)


AVH = 716          # 版心高度（A4 减去上下页边）


def stack_h(fl, w=CW):
    """估算一组 flowable 叠起来的高度；估不出来就返回一个很大的数，交给自然分页。"""
    t = 0
    for f in fl:
        try:
            t += f.wrap(w, AVH)[1]
        except Exception:
            return 10 ** 6
        if t > AVH * 4:
            return t
    return t


def hr(color="#CCCCCC", w=0.6, space=6):
    return HRFlowable(width="100%", thickness=w, color=HexColor(color),
                      spaceBefore=space, spaceAfter=space, dash=(1, 2))


def lead_block(text, color, st):
    t = Table([[Paragraph(inline(text), st.lead)]], colWidths=[CW])
    t.setStyle(TableStyle([
        ("LINEBEFORE", (0, 0), (0, 0), 2.2, HexColor(color)),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
    ]))
    return t


SECTION_LABEL = {"summary": "本节要点", "note": "知识点梳理", "abstract": "图示理解",
                 "example": "判断与解题流程", "important": "", "warning": "易错辨析",
                 "tip": "记忆要点", "question": "练习"}

# 已知可由表格替代的流程（拆写判断）：保留原图，条件整理成对照表
SPLIT_TABLE = [
    ("强酸、强碱、可溶性盐", "拆成离子（H⁺、OH⁻、盐的离子）"),
    ("弱酸、弱碱、难溶物、氧化物、气体、水、单质", "保留化学式"),
    ("微溶物作反应物（澄清溶液）", "拆成离子"),
    ("微溶物作反应物（浊液）或作生成物", "保留化学式"),
    ("浓硫酸、浓磷酸", "写分子形式"),
    ("浓盐酸、浓硝酸", "拆成离子"),
]


def _segments(text):
    out = []
    for m in re.finditer(r"[─—]{1,}[^─—▶→]{0,8}?[─—]*[▶→]", text):
        out.append(text[:m.start()].strip())
        text = text[m.end():]
    out.append(text.strip())
    return [s for s in out if s]



CHEM_SUB = str.maketrans("0123456789", "₀₁₂₃₄₅₆₇₈₉")
FORMULA = re.compile(r"(?<![A-Za-z0-9₀-₉])((?:[A-Z][a-z]?|\d|\(|\)|·)+)(\d+)(?![0-9])")


def chem_sub(t):
    """把 H2SO4 / Ca(OH)2 这类写法里的数字降为真下标字符（仅化学、生物两科）。"""
    def rep(m):
        return m.group(1) + m.group(2).translate(CHEM_SUB)
    prev = None
    out = t
    for _ in range(3):
        prev, out = out, out
        out = FORMULA.sub(rep, out)
        if out == prev:
            break
    return out


def _drop_by_fig(ls, text):
    """同一课时里已经画了矢量图，其余字符示意图就是重复，一律不印。"""
    subj = subject_of(ls)
    for it in FIGS.get(subj, []) or []:
        if it.get("lesson") != ls.get("fname"):
            continue
        anc = it.get("anchor") or ""
        if anc and anc in text:
            return False        # 这块要被矢量图取代，交给 _fig_for
        for d in it.get("drop") or []:
            if d and d in text:
                return True
        # 同一课时里剩下的字符示意图（含框线/箭头字符）属于重复
        if len(text.splitlines()) <= 16 and re.search(r"[─│├└┌┐┘┬┴┼▶◀▼▲→←]", text):
            return True
    return False


def _fig_for(ls, text):
    """真插图：overlays/figures.json 命中 anchor 时返回 (flowable, caption)。"""
    subj = subject_of(ls)
    for it in FIGS.get(subj, []) or []:
        if it.get("lesson") != ls.get("fname"):
            continue
        anc = it.get("anchor") or ""
        if anc and anc in text:
            try:
                from figlib import render as _fr
                fig = _fr(it.get("kind"), it.get("spec") or {}, CW)
                if fig is not None:
                    return fig, it.get("caption", "")
            except ImportError:
                if not CURRENT.get("_fig_warned"):
                    CURRENT["_fig_warned"] = True
                    print("  · 未装 figlib，overlays/figures.json 里的矢量图跳过（改用文本图）")
            except Exception as e:
                print("  ! 插图失败 %s：%s" % (it.get("lesson"), e))
    return None, ""


def mermaid_fallback(text):
    """overlay 缺失时的兜底：从 mermaid 源码里抽出节点与连线，排成等宽箭头链。"""
    nodes, order = {}, []
    for m in re.finditer(r"([A-Za-z0-9_]+)\s*[\[\(\{]+([^\]\)\}]*)[\]\)\}]+", text):
        k, lab = m.group(1), m.group(2).strip().strip('"')
        if k not in nodes:
            nodes[k] = lab
            order.append(k)
    # 端点可能带形状标签，如 A[溶液] --> B[胶体]，不能只认裸标识符
    _N = r"([A-Za-z0-9_]+)(?:\s*[\[\(\{]{1,2}[^\]\)\}]*[\]\)\}]{1,2})?"
    edges = re.findall(_N + r"\s*(?:-->|---|==>|-\.->)\s*(?:\|([^|]*)\|\s*)?" + _N, text)
    if not edges:
        return "\n".join("  " + nodes[k] for k in order)
    lines, seen = [], set()
    for a, lab, b in edges:
        lab = (lab or "").strip()
        key = (a, b, lab)
        if key in seen:
            continue
        seen.add(key)
        da, db = nodes.get(a, a), nodes.get(b, b)
        arrow = ("─▶ " + lab + " ") if lab else "─▶ "
        lines.append("  %s %s%s" % (da, arrow, db))
    for k in order:
        if not any(nodes.get(k) in l for l in lines):
            lines.insert(0, "  " + nodes[k])
    return "\n".join(lines)


def _block_flowables(b, ls, color, st, counter, split_tbl_done, long_list, seen_text):
    """把一个 block 转成 flowable 列表。返回 (flowables, counter, split_tbl_done, skipped)。"""
    out = []
    if b.kind == "h3":
        return [Paragraph(inline(b.text), st.h3)], 0, split_tbl_done, False
    if b.kind == "p":
        mm = re.fullmatch(r"\*(.+)\*", b.text.strip())
        if mm:
            return [Paragraph(inline(mm.group(1)), st.caption)], 0, split_tbl_done, False
        return [Paragraph(inline(b.text.replace("*", "")), st.body)], 0, split_tbl_done, False
    if b.kind == "li":
        if b.ordered:
            counter += 1
            pre = "%d.  " % counter
        else:
            counter = 0
            pre = "· "
        return [Paragraph(pre + inline(b.text), st.li)], counter, split_tbl_done, False
    if b.kind == "table":
        t = make_table(b.rows, color, st)
        return ([Spacer(1, 3), t, Spacer(1, 7)] if t else []), 0, split_tbl_done, False
    if b.kind == "img":
        im = load_image(b.name, subject_of(ls), CW)
        return ([Spacer(1, 4), im, Spacer(1, 2)] if im else []), 0, split_tbl_done, False
    if b.kind == "mermaid":
        subj = subject_of(ls)
        lines = (MERMAID.get(subj) or {}).get(ls.get("fname") or "")
        txt = "\n".join(lines) if lines else mermaid_fallback(b.text)
        if not lines:
            print("  · mermaid 兜底（无 overlay）：%s" % ls.get("fname"))
        if subj in ("化学", "生物"):
            txt = chem_sub(txt)
        return [Spacer(1, 3), AsciiFigure(txt, color, maxw=CW), Spacer(1, 7)], counter, split_tbl_done, False
    if b.kind == "skip":
        return [], counter, split_tbl_done, True
    if b.kind == "code":
        if _drop_by_fig(ls, b.text):
            return [], counter, split_tbl_done, True
        fig, cap = _fig_for(ls, b.text)
        if fig is not None:
            fl = [Spacer(1, 5), fig]
            if cap:
                fl.append(Paragraph(inline(cap), st.caption))
            fl.append(Spacer(1, 7))
            return fl, counter, split_tbl_done, False
        txt = chem_sub(b.text) if subject_of(ls) in ("化学", "生物") else b.text
        return [Spacer(1, 3), AsciiFigure(txt, color, maxw=CW), Spacer(1, 7)], \
            counter, split_tbl_done, False
    return [], counter, split_tbl_done, True


def split_ans(t):
    """答案拆三层：结论 / 解析 / 得分点。"""
    t = t.strip()
    pts = ""
    m = re.search(r"[①②③④⑤⑥]", t)
    if m and m.start() > 0:
        pts = t[m.start():].strip()
        t = t[:m.start()].strip()
    m2 = re.search(r"[。；]", t)
    if m2:
        concl, rest = t[:m2.start()].strip(), t[m2.end():].strip()
        if not rest:            # 标点就在句尾，整句都算结论，别把句号吃掉
            concl = t.strip()
    else:
        concl, rest = t, ""
    return concl or t, rest, pts


EX_NUM = re.compile(r"^\s*(?:\d+\s*[.、．]\s*|[-*]\s*\d+\s*[.、．]\s*|[-*]\s*|[（(]\d+[)）]\s*)")


def _render_exercise(blocks, color, st):
    """练习区：题号统一为 1. 2. 3.，前 3 题标「基础」，其后标「提升」。"""
    items = []
    for b in blocks:
        if b.kind == "li":
            txt = EX_NUM.sub("", b.text).strip()
            if txt:
                items.append(txt)
        elif b.kind == "p" and re.match(r"^\s*(?:\d+\s*[.、．]|[-*]\s*\d+\s*[.、．]|[-*]\s*)",
                                        b.text):
            # 只有本来就带编号的段落才算一道题；"（答案见下）"这类提示不算
            txt = EX_NUM.sub("", b.text).strip()
            if txt and len(txt) > 1 and not re.search(r"答案?见(下|后|次页)", txt):
                items.append(txt)
    if not items:
        return []
    out = []
    n_base = 3 if len(items) > 3 else len(items)
    for i, txt in enumerate(items, 1):
        if i == 1:
            out.append(Paragraph("基础", st.tag))
        elif i == n_base + 1:
            out.append(Paragraph("提升", st.tag))
        out.append(Paragraph("<b>%d.</b>　%s" % (i, inline(txt)), st.li))
    return out


TIGHT = set()
_TIGHT_CACHE = {}


def tight_styles(st):
    """尾页只剩一两行时，把这个课时的行距与段距收紧一点，让它回到上一页。"""
    key = id(st)
    if key in _TIGHT_CACHE:
        return _TIGHT_CACHE[key]
    import types
    out = types.SimpleNamespace()
    for nm in dir(st):
        if nm.startswith("_"):
            continue
        v = getattr(st, nm)
        if isinstance(v, ParagraphStyle):
            c = ParagraphStyle(nm + "_tight", parent=v)
            c.leading = max(v.leading * 0.955, v.fontSize * 1.32)
            c.spaceBefore = v.spaceBefore * 0.6
            c.spaceAfter = v.spaceAfter * 0.6
            out.__dict__[nm] = c
        else:
            out.__dict__[nm] = v
    _TIGHT_CACHE[key] = out
    return out


def render_lesson(ls, color, st):
    """返回该课时的 flowable 列表（不含标题）。"""
    out = []
    if ls["lead"]:
        out.append(Spacer(1, 2))
        out.append(lead_block(ls["lead"], color, st))
        out.append(Spacer(1, 7))
    seen_text = " ".join([ls["lead"]] + [b.text for s in ls["sections"] for b in s["blocks"]
                                         if b.kind in ("p", "li")])
    split_tbl_done = False
    ex_block, ans_block = [], []
    for sec in ls["sections"]:
        label = sec["label"] or SECTION_LABEL.get(sec["kind"], "")
        if not label or not sec["blocks"]:
            continue
        head = SectionHead(label, color)
        is_ex = ("练习" in label) or sec["kind"] == "question"
        if is_ex:
            body = _render_exercise(sec["blocks"], color, st)
            if body:
                ex_block = [head] + body
            continue
        counter = 0
        long_list = sum(1 for x in sec["blocks"] if x.kind == "li" and x.ordered) >= 4
        started = False
        for b in sec["blocks"]:
            fl, counter, split_tbl_done, skipped = _block_flowables(
                b, ls, color, st, counter, split_tbl_done, long_list, seen_text)
            if not fl:
                continue
            if not started:
                head2 = fl[:2]
                h2 = 0
                for f in head2:
                    try:
                        h2 += f.wrap(CW, 100000)[1]
                    except Exception:
                        h2 = 0
                        break
                if h2 <= 150:
                    out.append(KeepTogether([head] + head2))
                    out.extend(fl[2:])
                else:
                    out.append(head)
                    out.extend(fl)
                started = True
            else:
                out.extend(fl)
    tail = []
    if ls["answers"]:
        # 答案与题目按编号对齐；缺号的按顺序补位
        bynum = {}
        seq = []
        for a in ls["answers"]:
            if a["num"] is not None:
                bynum[a["num"]] = bynum.get(a["num"], "") + a["text"]
            else:
                seq.append(a["text"])
        n_ans = max(list(bynum.keys()) + [0])
        ans_block.append(Spacer(1, 5))
        ans_block.append(hr())
        ans_block.append(SectionHead("参考答案", color))
        for i in range(1, n_ans + 1):
            t = bynum.get(i) or (seq[i - 1] if i - 1 < len(seq) else "")
            if not t:
                continue
            concl, rest, pts = split_ans(t)
            ans_block.append(Paragraph("<b>%d. %s</b>" % (i, inline(concl)), st.a1))
            if rest:
                ans_block.append(Paragraph(inline(rest), st.a2))
            if pts:
                ans_block.append(Paragraph(inline(pts), st.a3))
    if ls["cards"]:
        card = [Spacer(1, 8), SectionHead("自测", color)]
        for i, (q, a) in enumerate(ls["cards"], 1):
            card.append(Paragraph("%d.  %s" % (i, inline(q)), st.li))
        card.append(Spacer(1, 4))
        card.append(Paragraph("自测答案", st.termx))
        for i, (q, a) in enumerate(ls["cards"], 1):
            card.append(Paragraph("%d. %s" % (i, inline(a)), st.cardans))
        if len(card) <= 30:
            out.append(KeepTogether(card))
        else:
            out.extend(card)
    # 练习与答案合成一块：能整块挪页就整块挪，避免只剩答案尾巴的短页
    if ex_block and ans_block:
        block = ex_block + ans_block
        # 整块塞得下（不超过半页）才整体挪页；否则让题、答案各自流动，
        # 免得出现"答案写完就换页、下半页全空"的废页
        if stack_h(block) <= AVH * 0.62:
            out.append(KeepTogether(block))
        else:
            out.extend(ex_block)
            out.extend(ans_block)
    else:
        out.extend(ex_block)
        out.extend(ans_block)
    if tail:
        out.append(tail[0])
        out.extend(tail[1:])
    out.append(Spacer(1, 16))
    return out


class SoftBreak(PageBreak):
    """只在当前页已经有内容时才翻页；否则什么也不做，避免印出空白页。"""

    def draw(self):
        doc = getattr(self.canv, "_doctemplate", None)
        if doc is not None and not getattr(doc, "_page_dirty", True):
            return
        PageBreak.draw(self)


class Book(BaseDocTemplate):
    _page_dirty = False

    def handle_pageBegin(self):
        BaseDocTemplate.handle_pageBegin(self)
        self._page_dirty = False
    def __init__(self, path, subject, color, **kw):
        BaseDocTemplate.__init__(self, path, pagesize=A4, leftMargin=ML, rightMargin=MR,
                                 topMargin=MT, bottomMargin=MB, title="高中%s 笔记（打印版）" % subject,
                                 author="个人笔记", **kw)
        self.subject, self.color = subject, HexColor(color)
        fr = Frame(ML, MB, CW, PH - MT - MB, id="n", leftPadding=0, rightPadding=0,
                   topPadding=0, bottomPadding=0)
        self.addPageTemplates([
            PageTemplate("cover", [fr], onPageEnd=self.p_cover),
            PageTemplate("front", [fr], onPageEnd=self.p_front),
            PageTemplate("body", [fr], onPageEnd=self.p_body),
        ])
        self.hdr_left = ""
        self.hdr_right = ""
        self.body_start = None
        self.page_map = {}
        self.fig_pages = {}
        self.vol_name = ""
        self.hdr_title = ""
        self.total_lessons = 0
        self.total_terms = 0

    # 封面
    def p_cover(self, c, doc):
        c.saveState()
        base = self.color
        deep = Color(base.red * 0.86, base.green * 0.86, base.blue * 0.86)
        panel_bottom = PH * 0.46

        c.setFillColor(deep)
        c.rect(0, panel_bottom, PW, PH - panel_bottom, stroke=0, fill=1)

        c.setStrokeColor(Color(1, 1, 1, 0.35))
        c.setLineWidth(0.7)
        c.line(ML + 14, PH - 104, ML + 214, PH - 104)

        c.setFillColor(Color(1, 1, 1, 0.92))
        c.setFont(HEI, 10.5)
        c.drawString(ML + 14, PH - 88, "高中笔记 · 课堂笔记与知识点速查")

        c.setFillColor(Color(1, 1, 1))
        c.setFont(HEI, 58)
        c.drawString(ML + 12, PH * 0.735, self.subject)

        # 册名：长度自适应，长册名换行
        c.setFillColor(Color(1, 1, 1, 0.94))
        nm = self.vol_name
        sz = 21.0
        while pdfmetrics.stringWidth(nm, HEI, sz) > CW - 30 and sz > 13:
            sz -= 0.5
        c.setFont(HEI, sz)
        c.drawString(ML + 14, PH * 0.735 - 52, nm)

        c.setFillColor(Color(1, 1, 1, 0.66))
        c.setFont(SONG, 9.4)
        c.drawString(ML + 14, panel_bottom + 22,
                     "%s　·　%d 个课时　·　%d 个知识点"
                     % (SUBJECT_EDITION.get(self.subject, "人教版"),
                        self.total_lessons, self.total_terms))

        y = panel_bottom - 52
        c.setFillColor(HexColor("#8A8A8A"))
        c.setFont(SONG, 9.6)
        c.drawString(ML, y, "本册结构")
        y -= 24
        for line in self.cover_lines:
            c.setFillColor(tint(base, 0.85))
            c.circle(ML + 3, y + 3, 1.5, stroke=0, fill=1)
            c.setFont(SONG, 10.6)
            c.setFillColor(HexColor("#232323"))
            c.drawString(ML + 13, y, line)

            y -= 21

        c.setStrokeColor(HexColor("#DCDCDC"))
        c.setLineWidth(0.6)
        c.line(ML, y - 4, PW - MR, y - 4)

        c.setFont(SONG, 8.8)
        c.setFillColor(HexColor("#8A8A8A"))
        c.drawString(ML, y - 22, "A4 双面 · 打印版")
        c.drawString(ML, y - 38, "供个人学习使用 · 非出版物")
        c.restoreState()

    def p_front(self, c, doc):
        pass

    def p_body(self, c, doc):
        if self.body_start is None:
            return
        rel = doc.page - self.body_start + 1
        c.saveState()
        if self.hdr_left:
            c.setFont(SONG, 8.4)
            c.setFillColor(HexColor("#5E5E5E"))
            c.drawString(ML, PH - MT + 16, self.hdr_left)
        if self.hdr_right:
            c.setFont(SONG, 8.4)
            c.setFillColor(HexColor("#5E5E5E"))
            c.drawRightString(PW - MR, PH - MT + 16, self.hdr_right)
        c.setStrokeColor(HexColor("#D2D2D2"))
        c.setLineWidth(0.5)
        c.line(ML, PH - MT + 10, PW - MR, PH - MT + 10)
        c.setFont(SONG, 9.2)
        c.setFillColor(HexColor("#444444"))
        c.drawCentredString(PW / 2, MB - 26, str(rel))
        c.restoreState()

    def afterFlowable(self, f):
        if not isinstance(f, (Spacer, SoftBreak)):
            self._page_dirty = True
        if isinstance(f, Head):
            if f.level == 1:
                if self.body_start is None:
                    self.body_start = self.page
                self.hdr_left = self.hdr_title
                self.hdr_right = f.text
            if f.key:
                base = self.body_start or self.page
                self.page_map[f.key] = self.page - base + 1
            if f.key.startswith("app"):
                self.hdr_left = ""
                self.hdr_right = f.text
        if isinstance(f, AsciiFigure):
            self.fig_pages.setdefault("first", self.page)


def vol_lessons(vol):
    n = 0
    for ch in vol["chapters"]:
        for u in ch["units"]:
            n += len(u["lessons"])
    return n


BLOCKS = [
    ("本节要点", "三到五条结论句，全节骨架", "上课前五分钟",
     "先读一遍，带着这几条听课；读完正文回来对一遍，缺哪条回去补"),
    ("知识点梳理", "定义、分类、表格、推导，正文主体", "课后当天",
     "逐节读；读表格时遮住右列自测，能默写出来才算过"),
    ("图示理解", "一张结构图或流程图", "梳理完正文之后",
     "只看图复述一遍，卡住的地方回正文找"),
    ("判断与解题流程", "一类题的判断顺序", "做作业卡住时",
     "按流程走一遍，把卡在第几步记下来"),
    ("高考考向与解题技巧", "考法、设问方式、踩分点", "单元复习时",
     "对照自己的错题，看错在考向判断还是计算"),
    ("必背速查", "必须背下来的条目，只留结论", "睡前、早读",
     "五分钟过一遍，第二天早读默写"),
    ("易错辨析", "混淆点与典型错答", "做题出错之后",
     "只找自己错的那一条，写下错因，不必通读"),
    ("记忆与复习", "记忆方法与复习节奏", "学完当天",
     "按当天、第 2 天、第 7 天、第 15 天排进日程"),
    ("练习", "四到六题，分基础与提升", "复习完当节之后",
     "先做基础；错两题以上不要做提升，回去重读知识点梳理"),
]


def intro_page(subject, vol, terms, color, st):
    """第二页：只讲结构、九个板块怎么用、一条阅读顺序。不许出现形容词式卖点。"""
    nch = len(vol["chapters"])
    nles = vol_lessons(vol)
    out = [Spacer(1, 18)]
    out.append(Paragraph("这本怎么用", ParagraphStyle(
        "t", fontName=HEI, fontSize=21, leading=29, textColor=HexColor("#141414"))))
    out.append(Spacer(1, 5))
    out.append(hr(color, 1.2, 7))
    out.append(Spacer(1, 10))

    out.append(Paragraph("一、本册结构", ParagraphStyle(
        "h1", fontName=HEI, fontSize=11.6, leading=18, textColor=HexColor(color),
        spaceBefore=2, spaceAfter=3)))
    out.append(Paragraph(inline(
        "本册为「%s·%s」，共 %d 章、%d 个课时。每课时固定九个板块，顺序不变。"
        "知识点不进正文，收在本册末尾的附录一（速查）与附录二（定位）。"
        % (subject, vol["name"], nch, nles)), st.body))
    out.append(Spacer(1, 8))

    out.append(Paragraph("二、九个板块怎么用", ParagraphStyle(
        "h2", fontName=HEI, fontSize=11.6, leading=18, textColor=HexColor(color),
        spaceBefore=2, spaceAfter=4)))
    rows = [[Paragraph("板块", st.cellh), Paragraph("是什么", st.cellh),
             Paragraph("什么时候读", st.cellh), Paragraph("怎么用", st.cellh)]]
    for nm, what, when, how in BLOCKS:
        rows.append([Paragraph(nm, ParagraphStyle("b1", parent=st.cell, fontName=HEI,
                                                  fontSize=8.0, textColor=HexColor(color))),
                     Paragraph(what, st.cell),
                     Paragraph(when, st.cell),
                     Paragraph(how, st.cell)])
    tb = Table(rows, colWidths=[74, 114, 70, CW - 258])
    tb.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), tint(color, 0.10)),
        ("LINEBELOW", (0, 0), (-1, 0), 0.7, HexColor("#8C8C8C")),
        ("LINEBELOW", (0, 1), (-1, -2), 0.3, HexColor("#DCDCDC")),
        ("BOX", (0, 0), (-1, -1), 0.6, HexColor("#BFBFBF")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 2.6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.8),
        ("LEFTPADDING", (0, 0), (-1, -1), 3.4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3.4),
    ]))
    out.append(tb)
    out.append(Spacer(1, 9))

    out.append(Paragraph("三、建议的顺序", ParagraphStyle(
        "h3x", fontName=HEI, fontSize=11.6, leading=18, textColor=HexColor(color),
        spaceBefore=2, spaceAfter=3)))
    out.append(Paragraph(inline(
        "课前读「本节要点」→ 课上记 → 当天读「知识点梳理」并默写表格 → 做「练习」的基础题 → "
        "隔一天做提升题 → 睡前过「必背速查」→ 按「记忆与复习」给的节奏复盘。"
        "做错的题回到「易错辨析」找对应条目，不要重读整节。"), st.body))
    return out


def toc_pages(vol, pm, color, st):
    out = [Spacer(1, 18)]
    out.append(Paragraph("目　录", ParagraphStyle("t2", fontName=HEI, fontSize=20, leading=28,
                                                  textColor=HexColor("#141414"))))
    out.append(Spacer(1, 4))
    out.append(hr(color, 1.2, 6))
    out.append(Spacer(1, 10))
    for ci, ch in enumerate(vol["chapters"]):
        out.append(TocLine(ch["name"], pm.get("c%d" % ci), 1, color))
        for ui, u in enumerate(ch["units"]):
            if u["name"]:
                out.append(TocLine(u["name"], pm.get("u%d_%d" % (ci, ui)), 2, color))
            for li, lp in enumerate(u["lessons"]):
                out.append(TocLine(os.path.basename(lp)[:-3],
                                   pm.get("l%d_%d_%d" % (ci, ui, li)), 3, color))
    for title, key in (("附录一　知识点速查", "app1"), ("附录二　知识定位", "app2")):
        out.append(Spacer(1, 3))
        out.append(TocLine(title, pm.get(key), 1, color))
    return out


def appendix_terms(subject, terms, pm, color, st):
    out = [SoftBreak(), Head("附录一　知识点速查", 1, color, key="app1",
                             note="按学册与章节顺序 · 一句定义 + 必要的判断要点")]
    by_vol = {}
    for t in terms:
        by_vol.setdefault(t["vol"], []).append(t)
    seen_expl = set()
    for vol in sorted(by_vol, key=lambda x: volkey(x)):
        out.append(Spacer(1, 10))
        out.append(Head(vol + "　知识点", 2, color, key="tv_" + vol))
        rows = []
        for t in by_vol[vol]:
            nm = Paragraph(inline(t["name"]), ParagraphStyle(
                "nm", fontName=HEI, fontSize=9.4, leading=13.4, wordWrap="CJK",
                textColor=HexColor(color)))
            defn = fix_text(t["def"])
            expl = fix_text(t["expl"])
            # 只保留确实在讲这个词条的句子，避免把同课通用段落搬进来
            sents = [x for x in re.split(r"(?<=。)", expl) if x.strip()]
            picked, total = [], 0
            dkey = _norm_sent(defn)[:14]
            for sent in sents:
                pos = sent.find(t["name"])
                if pos < 0 or pos > 12 or total >= 110:
                    continue
                if dkey and _norm_sent(sent).startswith(dkey):
                    continue
                picked.append(sent)
                total += len(sent)
            expl = "".join(picked)
            key = _norm_sent(expl)
            if len(key) < 12 or key in seen_expl or key == _norm_sent(defn) or \
                    _norm_sent(expl) in _norm_sent(defn):
                expl = ""
            else:
                seen_expl.add(key)
            body_txt = inline(defn)
            if expl:
                body_txt += '<br/><font size="8.2" color="#5A5A5A">%s</font>' % inline(expl)
            rows.append([nm, Paragraph(body_txt, st.termb)])
        if not rows:
            continue
        tb = Table(rows, colWidths=[92, CW - 92], repeatRows=0)
        tb.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LINEBELOW", (0, 0), (-1, -1), 0.35, HexColor("#DCDCDC")),
            ("TOPPADDING", (0, 0), (-1, -1), 4.6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5.2),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ]))
        out.append(tb)
    return out


def appendix_index(terms, lesson_links, pm, color, st, title_pages=None, term_pages=None):
    """附录二：按拼音排序的图书式索引。词条 + 出处 + 点线 + 页码。"""
    from pypinyin import lazy_pinyin
    out = [SoftBreak(), Head("附录二　知识定位", 1, color, key="app2",
                             note="按拼音排序 · 首讲篇目与页码")]
    items = [(t["name"], t) for t in terms]

    def pkey(nm):
        py = "".join(lazy_pinyin(nm)).lower()
        return (0 if py[:1].isascii() else 1, py)

    items.sort(key=lambda x: (pkey(x[0]), x[0]))
    miss = 0
    last = ""
    for nm, t in items:
        lesson = t.get("lesson") or ""
        pg_ = (term_pages or {}).get(nm)
        if pg_ is None:
            pg_ = (title_pages or {}).get(lesson)
        if pg_ is None:
            hit = lesson_links.get(nm, [])
            if hit:
                pg_ = pm.get(hit[0][0])
                lesson = lesson or hit[0][1]
        if pg_ is None:
            miss += 1
        loc = ("%s·%s" % (short_vol(t["vol"]), lesson)) if lesson else short_vol(t["vol"])
        first = pkey(nm)[1][:1].upper()
        if first and first != last:
            out.append(Spacer(1, 7))
            out.append(Paragraph('<font name="%s" size="12" color="%s">%s</font>'
                                 % (HEI, color, first),
                                 ParagraphStyle("il", leading=15, spaceAfter=2)))
            last = first
        out.append(IndexLine(nm, "", pg_, color))
    appendix_index.missing = miss
    return out


def pm_bodystart(pm):
    return pm.get("_body_start", 1)


def short_vol(n):
    m = re.search(r"选择性必修\s*([123])", n)
    if m:
        return "选必" + m.group(1)
    m = re.search(r"必修第?([一二三12])册?", n)
    if m:
        return "必修" + {"1": "一", "2": "二", "3": "三"}.get(m.group(1), m.group(1))
    return n


def volkey(name):
    m = re.search(r"必修第一册|必修第二册|必修1|必修2|选择性必修1|选择性必修2|选择性必修3|选择性必修第一册|选择性必修第二册|选择性必修第三册|高考考点", name)
    order = ["必修第一册", "必修1", "必修第二册", "必修2", "选择性必修1", "选择性必修第一册",
             "选择性必修2", "选择性必修第二册", "选择性必修3", "选择性必修第三册", "高考考点"]
    try:
        return (order.index(m.group(0)) if m else 50, name)
    except ValueError:
        return (50, name)


def index_structure(vols):
    idx = []
    for vi, vol in enumerate(vols):
        for ci, ch in enumerate(vol["chapters"]):
            for ui, u in enumerate(ch["units"]):
                for li, lp in enumerate(u["lessons"]):
                    idx.append({"key": "l%d_%d_%d_%d" % (vi, ci, ui, li), "path": lp,
                                "vol": vol["name"], "chapter": ch["name"],
                                "unit": u["name"], "title": os.path.basename(lp)[:-3]})
    return idx


def collect_links(idx):
    links = {}
    for it in idx:
        try:
            raw = open(it["path"], encoding="utf-8").read()
        except Exception:
            continue
        for m in WIKI.finditer(raw):
            tgt = m.group(1).split("#")[0].strip()
            if not tgt or tgt.endswith((".png", ".jpg", ".svg")):
                continue
            lst = links.setdefault(tgt, [])
            if not lst or lst[-1][0] != it["key"]:
                lst.append((it["key"], it["title"]))
    return links


def first_point(ls, limit=46):
    """取「本节要点」首句，做章首页的一行提要。"""
    for sec in ls["sections"]:
        if sec["kind"] == "summary" or "要点" in (sec["label"] or ""):
            for b in sec["blocks"]:
                if b.kind in ("p", "li"):
                    t = re.sub(r"[*`>]", "", b.text).strip()
                    t = WIKI.sub(lambda m: (m.group(2) or m.group(1)).strip(), t)
                    if len(t) > limit:
                        cut = max(t.rfind("，", 0, limit), t.rfind("；", 0, limit))
                        t = t[:cut] if cut > 18 else t[:limit]
                    return t
    return ""


def sec_first(ls, key, limit=52):
    for sec in ls["sections"]:
        if key in (sec["label"] or ""):
            for b in sec["blocks"]:
                if b.kind in ("p", "li"):
                    t = re.sub(r"[*`>]", "", b.text).strip()
                    t = WIKI.sub(lambda m: (m.group(2) or m.group(1)).strip(), t)
                    t = re.sub(r"^\d+\s*[.、．]\s*", "", t)
                    if len(t) > limit:
                        cut = max(t.rfind("，", 0, limit), t.rfind("；", 0, limit),
                                  t.rfind("：", 0, limit))
                        t = t[:cut] if cut > 20 else t[:limit]
                    return t
    return ""


def chapter_opener(ch, parsed, terms, color, st):
    """章首页正文：章级提要 + 课时清单。保证章标题下至少有 6 行内容。"""
    out = [Spacer(1, 12)]
    n_les = sum(len(u["lessons"]) for u in ch["units"])
    n_kw = len([t for t in terms if t.get("chapter") and ch["name"] in t["chapter"]])
    head = "本章 %d 课" % n_les
    if n_kw:
        head += "　·　%d 个知识点" % n_kw
    out.append(Paragraph(head, ParagraphStyle(
        "chm", fontName=HEI, fontSize=9.6, leading=15, textColor=HexColor(color))))
    out.append(Spacer(1, 8))
    rows = []
    for u in ch["units"]:
        if u["name"]:
            rows.append([Paragraph(inline(u["name"]), st.cellh), ""])
        for lp in u["lessons"]:
            ls = parsed[lp]
            rows.append([Paragraph(inline(ls["title"]), ParagraphStyle(
                "cn", parent=st.cell, fontName=SONG, fontSize=9.2)),
                Paragraph(inline(first_point(ls)), ParagraphStyle(
                    "cd", parent=st.cell, fontSize=8.6, textColor=HexColor("#5E5E5E")))])
    if rows:
        tb = Table(rows, colWidths=[132, CW - 132])
        tb.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LINEBELOW", (0, 0), (-1, -1), 0.3, HexColor("#E4E4E4")),
            ("TOPPADDING", (0, 0), (-1, -1), 3.4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3.8),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ]))
        out.append(tb)

    # 本章考点：把各课「高考考向」首句并排，填满章首页并给出查考点的入口
    rows2 = []
    for u in ch["units"]:
        for lp in u["lessons"]:
            ls = parsed[lp]
            t = sec_first(ls, "高考考向")
            if t:
                rows2.append([Paragraph(inline(ls["title"]), ParagraphStyle(
                    "kx", parent=st.cell, fontSize=8.4)),
                    Paragraph(inline(t), ParagraphStyle(
                        "kx2", parent=st.cell, fontSize=8.4, textColor=HexColor("#4A4A4A")))])
    if len(rows2) >= 3:
        out.append(Spacer(1, 12))
        out.append(Paragraph("本章考点分布", ParagraphStyle(
            "kxh", fontName=HEI, fontSize=9.6, leading=15, textColor=HexColor(color))))
        out.append(Spacer(1, 5))
        tb2 = Table(rows2, colWidths=[118, CW - 118])
        tb2.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LINEBELOW", (0, 0), (-1, -1), 0.3, HexColor("#E4E4E4")),
            ("TOPPADDING", (0, 0), (-1, -1), 3.0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3.4),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ]))
        out.append(tb2)
    return out


def assemble(subject, vol, terms, links, pm, parsed, title_pages=None, term_pages=None):
    """一册一 PDF：封面 → 这本怎么用 → 目录 → 凡例 → 正文 → 两个附录。"""
    color = SUBJECT_COLOR.get(subject) or "#3A3A3A"
    st = make_styles(color)
    story = [Spacer(1, 1), NextPageTemplate("front"), SoftBreak()]
    story.append(KeepInFrame(CW, AVH, intro_page(subject, vol, terms, color, st),
                             mode="shrink"))
    story.append(SoftBreak())
    story += toc_pages(vol, pm, color, st)
    # 凡例单独占一页并整体缩放：它比半页高，直接接在目录后面会把表尾挤到新页
    story.append(SoftBreak())
    story.append(KeepInFrame(CW, AVH, fanli(subject, color, st), mode="shrink"))
    story += [NextPageTemplate("body"), SoftBreak()]

    for ci, ch in enumerate(vol["chapters"]):
        if ci:
            story.append(SoftBreak())
        story.append(Head(ch["name"], 1, color, note="", key="c%d" % ci))
        op = chapter_opener(ch, parsed, terms, color, st)
        story += op
        # 章导览很短时（小章只有两节课），不要让它独占一页，直接接排第一课
        merge_first = stack_h(op) < AVH * 0.34
        for ui, u in enumerate(ch["units"]):
            for li, lp in enumerate(u["lessons"]):
                ls = parsed[lp]
                if not (merge_first and ci >= 0 and ui == 0 and li == 0):
                    story.append(SoftBreak())
                if li == 0 and u["name"]:
                    story.append(Head(u["name"], 2, color, key="u%d_%d" % (ci, ui)))
                story.append(Head(ls["title"], 3, color, note="", key="l%d_%d_%d" % (ci, ui, li)))
                key = "l%d_%d_%d" % (ci, ui, li)
                CURRENT["lkey"] = key
                story += render_lesson(ls, color, tight_styles(st) if key in TIGHT else st)
    story = _kill_double_break(story)
    story += appendix_terms(subject, terms, pm, color, st)
    story += appendix_index(terms, links, pm, color, st, title_pages, term_pages)
    return story


def _kill_double_break(story):
    """相邻两次分页会印出一整页空白，中间夹的空格也没有意义，一并去掉。"""
    out = []
    pending_space = []
    prev_break = True          # 开头不必要再分页
    for f in story:
        if isinstance(f, PageBreak):
            # 分页符前面的空档没有意义，还会把整页撑成空白页
            pending_space = []
            if prev_break:
                continue
            out.append(f)
            prev_break = True
            continue
        if isinstance(f, Spacer):
            pending_space.append(f)
            continue
        out.extend(pending_space)
        pending_space = []
        out.append(f)
        prev_break = False
    out.extend(pending_space)
    return out


def build_vol(subject, vol, out_pdf, terms, maxpass=4, verbose=True):
    CURRENT["subject"] = subject
    if subject not in PATCHES_BY_SUBJECT:
        PATCHES_BY_SUBJECT[subject] = load_subject_patches(subject)
    parsed = {}
    for ch in vol["chapters"]:
        for u in ch["units"]:
            for lp in u["lessons"]:
                parsed[lp] = parse_lesson(lp)
    idx = []
    for ci, ch in enumerate(vol["chapters"]):
        for ui, u in enumerate(ch["units"]):
            for li, lp in enumerate(u["lessons"]):
                idx.append({"key": "l%d_%d_%d" % (ci, ui, li), "path": lp,
                            "title": os.path.basename(lp)[:-3]})
    links = {}
    for it in idx:
        try:
            raw = open(it["path"], encoding="utf-8").read()
        except Exception:
            continue
        for m in WIKI.finditer(raw):
            tgt = m.group(1).split("#")[0].strip()
            if not tgt or tgt.endswith((".png", ".jpg", ".svg")):
                continue
            lst = links.setdefault(tgt, [])
            if not lst or lst[-1][0] != it["key"]:
                lst.append((it["key"], it["title"]))
    color = SUBJECT_COLOR.get(subject) or "#3A3A3A"
    pm, prev, doc = {}, None, None
    term_pages = {}
    for p in range(maxpass):
        title_pages = {it["title"]: pm.get(it["key"]) for it in idx}
        story = assemble(subject, vol, terms, links, pm, parsed, title_pages, term_pages)
        doc = Book(out_pdf, subject, color)
        doc.vol_name = vol["name"]
        doc.cover_lines = ["%s　%d 课" % (ch["name"], sum(len(u["lessons"]) for u in ch["units"]))
                           for ch in vol["chapters"]][:7]
        doc.cover_lines += ["附录一 知识点速查　·　附录二 知识定位"]
        doc.hdr_title = "%s　%s" % (subject, vol["name"])
        doc.total_lessons = vol_lessons(vol)
        doc.total_terms = len(terms)
        doc.build(story)
        new = dict(doc.page_map)
        new["_body_start"] = doc.body_start
        if verbose:
            print("    pass %d → %d 页" % (p + 1, doc.page))
        if prev == new:
            break
        prev, pm = new, new

    def rebuild(tag):
        nonlocal doc
        tpages = {it["title"]: pm.get(it["key"]) for it in idx}
        st_ = assemble(subject, vol, terms, links, pm, parsed, tpages, term_pages)
        d = Book(out_pdf, subject, color)
        d.vol_name = vol["name"]
        d.hdr_title = "%s　%s" % (subject, vol["name"])
        d.total_lessons = vol_lessons(vol)
        d.total_terms = len(terms)
        d.cover_lines = ["%s　%d 课" % (ch["name"], sum(len(u["lessons"]) for u in ch["units"]))
                         for ch in vol["chapters"]][:7]
        d.cover_lines += ["附录一 知识点速查　·　附录二 知识定位"]
        d.build(st_)
        if verbose:
            print("    %s → %d 页" % (tag, d.page))
        return d

    def calib(d):
        m = dict(d.page_map)
        m["_body_start"] = d.body_start
        return m

    # 尾页只剩一两行的课时：收紧行距让它回到上一页，避免整页只剩一句话
    try:
        tight = scan_tail_lessons(out_pdf, doc, pm, vol)
        if tight and tight != TIGHT:
            TIGHT.clear()
            TIGHT.update(tight)
            doc = rebuild("尾页紧排 %d 课" % len(tight))
    except Exception as e:
        print("    ! 尾页紧排失败：%s" % e)

    # 定位精确到"首次出现页"：索引指向课时首页但词条不在首页时，读者找不到
    try:
        tp = scan_term_pages(out_pdf, doc, pm, vol, terms)
        if tp and tp != term_pages:
            term_pages = tp
            doc = rebuild("索引定位重排")
    except Exception as e:
        print("    ! 索引定位失败：%s" % e)

    # 前面两步会改变正文分页，目录里的页码必须重新校准，否则会指错
    try:
        for _ in range(3):
            new = calib(doc)
            if new == pm:
                break
            pm = new
            doc = rebuild("页码校准")
    except Exception as e:
        print("    ! 页码校准失败：%s" % e)
    return doc, pm, parsed



def scan_tail_lessons(pdf, doc, pm, vol):
    """找出"末页只剩一两行"的课时（按字数量判断），返回课时键集合。"""
    import pymupdf
    bs = doc.body_start or 1
    starts = []
    for ci, ch in enumerate(vol["chapters"]):
        for ui, u in enumerate(ch["units"]):
            for li, lp in enumerate(u["lessons"]):
                pg = pm.get("l%d_%d_%d" % (ci, ui, li))
                if pg:
                    starts.append((pg, "l%d_%d_%d" % (ci, ui, li)))
    if len(starts) < 2:
        return set()
    starts.sort()
    d = pymupdf.open(pdf)
    lens = {}
    for i in range(d.page_count):
        lens[i + 1 - (bs - 1)] = len(re.sub(r"\s+", "", d[i].get_text() or ""))
    d.close()
    body = [n for p_, n in lens.items() if n > 200]
    avg = sum(body) / max(1, len(body))
    out = set()
    for k in range(len(starts) - 1):
        last = starts[k + 1][0] - 1
        n = lens.get(last, 0)
        if n < avg * 0.18:
            out.add(starts[k][1])
    return out


def scan_term_pages(pdf, doc, pm, vol, terms):
    """扫成品，给每个词条找首次出现的印刷页码（限定在该词条所属课时内）。"""
    import pymupdf
    bs = doc.body_start or 1

    # 课时起始页（印刷页码），按顺序
    starts = []
    for ci, ch in enumerate(vol["chapters"]):
        for ui, u in enumerate(ch["units"]):
            for li, lp in enumerate(u["lessons"]):
                pg = pm.get("l%d_%d_%d" % (ci, ui, li))
                if pg:
                    starts.append((pg, os.path.basename(lp)[:-3]))
    starts.sort()
    if not starts:
        return {}
    d = pymupdf.open(pdf)
    texts = []
    for i in range(d.page_count):
        texts.append(re.sub(r"\s+", "", d[i].get_text() or ""))
    d.close()

    def printed_of(i):
        return i + 1 - (bs - 1)

    out = {}
    for t in terms:
        nm = re.sub(r"\s+", "", t["name"])
        if not nm:
            continue
        lo = 0
        for k, (pg, title) in enumerate(starts):
            if title == t.get("lesson"):
                lo = k
                break
        p_start = starts[lo][0]
        p_end = starts[lo + 1][0] - 1 if lo + 1 < len(starts) else len(texts) - (bs - 1)
        i0 = max(0, p_start + bs - 2)
        i1 = min(len(texts) - 1, p_end + bs - 2)
        hit = None
        for i in range(i0, i1 + 1):
            if nm in texts[i]:
                hit = i
                break
        if hit is None:      # 课时字段写错时，退一步全册找
            for i in range(len(texts)):
                if nm in texts[i]:
                    hit = i
                    break
        if hit is not None:
            out[t["name"]] = printed_of(hit)
    return out


def fanli(subject, color, st):
    """凡例：符号与版式约定，不超过半页。"""
    out = [Spacer(1, 10)]
    out.append(Paragraph("凡例", ParagraphStyle("fl", fontName=HEI, fontSize=15, leading=22,
                                                textColor=HexColor(color))))
    out.append(Spacer(1, 8))
    rows = [
        ("▍板块标题", "左侧竖线加底色条，九个板块固定顺序，不调换"),
        ("加粗小标题", "板块内的下一级标题，只加粗、不占整行"),
        ("粗体", "结论、术语、必背条目，不加底色"),
        ("灰底 / 灰字", "易错辨析里的错误说法；答案的解析行"),
        ("①②③", "解答题的得分点，按步给分的位置"),
        ("△　⇌　↑　↓", "加热、可逆、气体、沉淀"),
        ("等宽图块", "字符画的树与流程，树线上下相连，供看清层级"),
        ("图 3-1", "真插图编号，章号在前；图题在图下"),
        ("基础 / 提升", "练习分层，前段直接考结论，后段要联用两处以上知识"),
        ("附录一 / 附录二", "知识点速查（按册序）／知识定位（按拼音）"),
    ]
    data = [[Paragraph(a, st.cellh), Paragraph(b, st.cell)] for a, b in rows]
    tb = Table(data, colWidths=[104, CW - 104])
    tb.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.3, HexColor("#E2E2E2")),
        ("TOPPADDING", (0, 0), (-1, -1), 3.6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ]))
    out.append(tb)
    return out


def build(subject, verbose=True, only=None):
    """一个科目拆成若干册，每册一个 PDF。返回 [(册名, pdf, 页数)]。"""
    vols = scan_subject(subject)
    terms_all = scan_terms(subject)
    outdir = os.path.join(OUTDIR, subject)
    os.makedirs(outdir, exist_ok=True)
    made = []
    for vi, vol in enumerate(vols):
        if only and vol["name"] != only:
            continue
        terms = [t for t in terms_all if t["vol"] == vol["name"]]
        safe = re.sub(r"[/\\]", "-", vol["name"])
        pdf = os.path.join(outdir, "%s·%s.pdf" % (subject, safe))
        if verbose:
            print("  [%d/%d] %s（%d 课 / %d 词条）" % (vi + 1, len(vols), vol["name"],
                                                    vol_lessons(vol), len(terms)))
        try:
            doc, pm, parsed = build_vol(subject, vol, pdf, terms, verbose=verbose)
            made.append((vol["name"], pdf, doc.page))
        except Exception as e:
            import traceback
            traceback.print_exc()
            made.append((vol["name"], pdf, -1))
            print("  !! %s 生成失败：%s" % (vol["name"], e))
    return made


def export_samples(pdf, outdir, pages):
    import fitz
    os.makedirs(outdir, exist_ok=True)
    doc = fitz.open(pdf)
    made = []
    for name, pno in pages.items():
        if not pno or pno < 1 or pno > doc.page_count:
            continue
        pix = doc[pno - 1].get_pixmap(dpi=150)
        png = os.path.join(outdir, "%s.png" % name)
        pix.save(png)
        made.append(png)
    doc.close()
    return made


def main():
    global VAULT, OUTDIR
    ap = argparse.ArgumentParser(
        description="把 Obsidian 笔记库渲染成可打印的 A4 书。")
    ap.add_argument("subjects", nargs="*", default=None,
                    help="科目名，缺省为全部九科")
    ap.add_argument("--vault", default=None, help="笔记库根目录（只读）")
    ap.add_argument("--outdir", default=None, help="成品输出目录")
    ap.add_argument("--only", default=None, help="只做某一册（册名全称）")
    ap.add_argument("--sample", action="store_true", help="同时导出校对样张")
    a = ap.parse_args()
    if a.vault:
        VAULT = os.path.abspath(os.path.expanduser(a.vault))
    if a.outdir:
        OUTDIR = os.path.abspath(os.path.expanduser(a.outdir))
    if not os.path.isdir(VAULT):
        print("笔记库不存在：%s\n用 --vault 指定笔记库根目录。" % VAULT, file=sys.stderr)
        return 2
    subs = a.subjects or [d for d in sorted(os.listdir(VAULT))
                          if os.path.isdir(os.path.join(VAULT, d)) and not d.startswith(".")]
    explicit = bool(a.subjects)
    os.makedirs(OUTDIR, exist_ok=True)

    total = done = 0
    failed = []
    available = []
    for subj in subs:
        try:
            vols = scan_subject(subj)
        except OSError as e:
            print("! %s 读取失败：%s" % (subj, e))
            failed.append(subj)
            continue
        if a.only:
            available += [v["name"] for v in vols]
        if not vols:
            if explicit and not a.only:
                print("! %s 下没有可排的册：检查层级是不是 科目/册/专题/单元/*.md" % subj)
                failed.append(subj)
            else:
                print("· 跳过 %s（不是科目目录，或没有课时）" % subj)
            continue
        print("== %s" % subj)
        for name, pdf, pages in build(subj, only=a.only):
            if pages < 0:
                failed.append("%s·%s" % (subj, name))
                continue
            print("   %-28s %4s 页  %s" % (name, pages, os.path.basename(pdf)))
            total += pages
            done += 1
            if a.sample:
                pgs = {"01-封面": 1, "02-使用说明": 2, "03-目录": 3, "04-凡例": 4,
                       "05-章首页": 5, "06-课时": 6, "07-课时次页": 7}
                made = export_samples(pdf, os.path.join(OUTDIR, "校对样张", subj), pgs)
                print("     样张 %d 张" % len(made))

    print("合计 %d 页 / %d 册" % (total, done))

    # --only 一册都没匹配上：多半是册名写错了，把能用的名字列出来
    if a.only and done == 0:
        print("\n! --only %r 没有匹配到任何册。" % a.only)
        if available:
            print("  可用册名（照抄，含空格）：")
            for n in dict.fromkeys(available):
                print("    %s" % n)
        return 2
    if failed:
        print("\n! %d 项没成：%s" % (len(failed), "、".join(failed)), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
