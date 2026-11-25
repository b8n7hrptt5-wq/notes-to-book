import { inflate } from "pako";
import type { PdfDigest } from "./verify";

/**
 * 只做一件小事的 PDF 文本抽取：够核对用，不追求还原版面。
 * Chromium 打出来的 PDF 是 FlateDecode + 子集化字体 + ToUnicode，就按这三件事写。
 */

const CHUNK = 0x8000;
function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(b.subarray(i, i + CHUNK)) as number[]);
  }
  return s;
}

interface PdfObj {
  num: number;
  raw: string;
  stream?: Uint8Array;
}

function splitStream(raw: string): { dict: string; stream?: Uint8Array } {
  const i = raw.search(/\bstream\r?\n/);
  if (i < 0) return { dict: raw };
  const dict = raw.slice(0, i);
  let start = i + 6;
  if (raw[start] === "\r") start++;
  if (raw[start] === "\n") start++;
  const end = raw.indexOf("endstream", start);
  const bytes = new Uint8Array(raw.length);
  for (let k = 0; k < raw.length; k++) bytes[k] = raw.charCodeAt(k) & 0xff;
  return { dict, stream: bytes.subarray(start, end < 0 ? raw.length : end) };
}

function inflateMaybe(dict: string, data?: Uint8Array): Uint8Array | undefined {
  if (!data) return undefined;
  if (!/\/Filter\s*\/FlateDecode/.test(dict)) return data;
  try {
    return inflate(data);
  } catch {
    return undefined;
  }
}

function hexToUnicode(h: string): string {
  let out = "";
  for (let i = 0; i + 4 <= h.length; i += 4) {
    out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
  }
  if (!out && h.length === 2) out = String.fromCharCode(parseInt(h, 16));
  return out;
}

function parseToUnicode(cmap: string): { map: Map<number, string>; width: number } {
  const map = new Map<number, string>();
  let width = 1;
  const cs = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(cmap);
  if (cs) width = cs[1].length > 2 ? 2 : 1;

  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
  let b: RegExpExecArray | null;
  while ((b = bfchar.exec(cmap))) {
    const pairs = b[1].match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g) ?? [];
    for (const p of pairs) {
      const parts = p.replace(/[<>]/g, " ").trim().split(/\s+/);
      map.set(parseInt(parts[0], 16), hexToUnicode(parts[1]));
    }
  }

  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
  let r: RegExpExecArray | null;
  while ((r = bfrange.exec(cmap))) {
    const trip = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g;
    let t: RegExpExecArray | null;
    while ((t = trip.exec(r[1]))) {
      const lo = parseInt(t[1], 16);
      const hi = parseInt(t[2], 16);
      if (t[3]) {
        const base = parseInt(t[3], 16);
        for (let c = lo; c <= hi && c - lo < 65535; c++) map.set(c, String.fromCharCode(base + (c - lo)));
      } else if (t[4]) {
        const items = t[4].match(/<([0-9a-fA-F]+)>/g) ?? [];
        items.forEach((h, i) => map.set(lo + i, hexToUnicode(h.replace(/[<>]/g, ""))));
      }
    }
  }
  return { map, width };
}

type Decoder = (bytes: string) => string;

export function extractPdf(data: Uint8Array): PdfDigest {
  const text = latin1(data);
  const objs = new Map<number, PdfObj>();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    let end = text.indexOf("endobj", start);
    if (end < 0) end = text.length;
    // 只在本对象范围内找 stream，否则会把后面的对象一起吞掉
    const seg = text.slice(start, end);
    const streamAt = /(^|[^a-zA-Z])stream\r?\n/.exec(seg);
    if (streamAt) {
      const abs = start + streamAt.index + streamAt[0].length;
      const eIdx = text.indexOf("endstream", abs);
      const after = eIdx >= 0 ? text.indexOf("endobj", eIdx) : -1;
      end = after >= 0 ? after : end;
    }
    const raw = text.slice(start, end);
    const { stream } = splitStream(raw);
    objs.set(num, { num, raw, stream });
    re.lastIndex = end < 0 ? text.length : end;
  }

  const refOf = (s?: string): number | undefined => {
    const mm = s ? /(\d+)\s+\d+\s+R/.exec(s) : null;
    return mm ? Number(mm[1]) : undefined;
  };
  const dictOf = (num?: number): string => (num == null ? "" : (objs.get(num)?.raw ?? ""));

  const pageNums: number[] = [];
  for (const [num, obj] of objs) {
    if (/\/Type\s*\/Page(?![a-zA-Z])/.test(obj.raw)) pageNums.push(num);
  }
  pageNums.sort((a, b) => a - b);

  const decoders = new Map<number, Decoder>();

  function decoderFor(fontNum: number): Decoder {
    const hit = decoders.get(fontNum);
    if (hit) return hit;
    const dict = dictOf(fontNum);
    const isType0 = /\/Subtype\s*\/Type0/.test(dict);
    const tuNum = refOf(/\/ToUnicode\s+(\d+\s+\d+\s+R)/.exec(dict)?.[1]);
    let dec: Decoder = (b) => b;
    const tuObj = tuNum != null ? objs.get(tuNum) : undefined;
    if (tuObj) {
      const cm = inflateMaybe(tuObj.raw, tuObj.stream);
      if (cm) {
        const { map, width } = parseToUnicode(latin1(cm));
        const w = isType0 ? 2 : width;
        dec = (s) => {
          let out = "";
          for (let i = 0; i < s.length; i += w) {
            const code = w === 2 ? (s.charCodeAt(i) << 8) | (s.charCodeAt(i + 1) ?? 0) : s.charCodeAt(i);
            out += map.get(code) ?? "";
          }
          return out;
        };
      }
    }
    decoders.set(fontNum, dec);
    return dec;
  }

  const pages: { text: string; images: number }[] = [];

  const fontMapOf = (resRaw: string): Map<string, number> => {
    const fonts = new Map<string, number>();
    const block =
      /\/Font\s*<<([\s\S]*?)>>/.exec(resRaw)?.[1] ??
      dictOf(refOf(/\/Font\s+(\d+\s+\d+\s+R)/.exec(resRaw)?.[1]));
    for (const fm of block.matchAll(/\/([A-Za-z0-9+.-]+)\s+(\d+)\s+\d+\s+R/g)) {
      fonts.set(fm[1], Number(fm[2]));
    }
    return fonts;
  };

  const xobjectsOf = (resRaw: string): { name: string; num: number }[] => {
    const block =
      /\/XObject\s*<<([\s\S]*?)>>/.exec(resRaw)?.[1] ??
      dictOf(refOf(/\/XObject\s+(\d+\s+\d+\s+R)/.exec(resRaw)?.[1]));
    const out: { name: string; num: number }[] = [];
    for (const xm of block.matchAll(/\/([A-Za-z0-9+.-]+)\s+(\d+)\s+\d+\s+R/g)) {
      out.push({ name: xm[1], num: Number(xm[2]) });
    }
    return out;
  };

  /** 递归解析内容流；Chromium 常把整页包进 Form XObject */
  const parseStream = (content: string, fonts: Map<string, number>, resRaw: string, depth: number): string => {
    let out = contentToText(content, fonts, decoderFor);
    if (depth >= 3) return out;
    for (const xo of xobjectsOf(resRaw)) {
      const obj = objs.get(xo.num);
      if (!obj || !/\/Subtype\s*\/Form/.test(obj.raw)) continue;
      const data = inflateMaybe(obj.raw, obj.stream);
      if (!data) continue;
      const subRes = obj.raw;
      const subFonts = fontMapOf(subRes);
      out += "\n" + parseStream(latin1(data), subFonts.size ? subFonts : fonts, subRes, depth + 1);
    }
    return out;
  };

  const countImages = (resRaw: string, depth: number): number => {
    let n = 0;
    for (const xo of xobjectsOf(resRaw)) {
      const obj = objs.get(xo.num);
      if (!obj) continue;
      if (/\/Subtype\s*\/Image/.test(obj.raw)) n++;
      else if (depth < 3 && /\/Subtype\s*\/Form/.test(obj.raw)) n += countImages(obj.raw, depth + 1);
    }
    return n;
  };

  for (const pnum of pageNums) {
    const page = objs.get(pnum)!;
    const resNum = refOf(/\/Resources\s+(\d+\s+\d+\s+R)/.exec(page.raw)?.[1]);
    const resRaw = resNum != null ? dictOf(resNum) : page.raw;

    const contRaw = /\/Contents\s*(\[[\s\S]*?\]|\d+\s+\d+\s+R)/.exec(page.raw)?.[1] ?? "";
    let content = "";
    for (const a of contRaw.match(/\d+\s+\d+\s+R/g) ?? []) {
      const o = objs.get(Number(a.split(/\s+/)[0]));
      const d = o ? inflateMaybe(o.raw, o.stream) : undefined;
      if (d) content += latin1(d) + "\n";
    }

    const text = parseStream(content, fontMapOf(resRaw), resRaw, 0);
    pages.push({ text, images: countImages(resRaw, 0) });
  }

  return { pages };
}

function contentToText(content: string, fonts: Map<string, number>, decoderFor: (n: number) => Decoder): string {
  let out = "";
  let dec: Decoder = (b) => b;
  let i = 0;
  const n = content.length;
  let lastName = "";
  let lastBaseline: number | null = null;
  const operands: (string | number)[] = [];

  const readLiteral = (): string => {
    i++;
    let s = "";
    let depth = 1;
    while (i < n && depth > 0) {
      const c = content[i];
      if (c === "\\") {
        const nx = content[i + 1];
        if (nx === "n") s += "\n";
        else if (nx === "r") s += "\r";
        else if (nx === "t") s += "\t";
        else if (nx === "\n") {
          i += 2;
          continue;
        } else s += nx;
        i += 2;
        continue;
      }
      if (c === "(") depth++;
      if (c === ")") {
        depth--;
        if (!depth) break;
      }
      s += c;
      i++;
    }
    i++;
    return s;
  };

  const readHex = (): string => {
    i++;
    let h = "";
    while (i < n && content[i] !== ">") {
      h += content[i];
      i++;
    }
    i++;
    h = h.replace(/\s+/g, "");
    let s = "";
    for (let k = 0; k + 2 <= h.length; k += 2) s += String.fromCharCode(parseInt(h.slice(k, k + 2), 16));
    return s;
  };

  while (i < n) {
    const c = content[i];
    if (c === " " || c === "\n" || c === "\r" || c === "\t") {
      i++;
      continue;
    }
    if (c === "%") {
      while (i < n && content[i] !== "\n") i++;
      continue;
    }
    if (c === "(") {
      operands.push(dec(readLiteral()));
      continue;
    }
    if (c === "<" && content[i + 1] !== "<") {
      operands.push(dec(readHex()));
      continue;
    }
    if (c === "<" && content[i + 1] === "<") {
      let depth = 0;
      while (i < n) {
        if (content[i] === "<" && content[i + 1] === "<") {
          depth++;
          i += 2;
          continue;
        }
        if (content[i] === ">" && content[i + 1] === ">") {
          depth--;
          i += 2;
          if (!depth) break;
          continue;
        }
        i++;
      }
      continue;
    }
    if (c === "[" || c === "]") {
      i++;
      continue;
    }
    if (c === "/") {
      i++;
      let name = "";
      while (i < n && !/[\s/\[\]<>()]/.test(content[i])) {
        name += content[i];
        i++;
      }
      lastName = name;
      operands.push(`/${name}`);
      continue;
    }
    if (/[-+.\d]/.test(c)) {
      let num = "";
      while (i < n && /[-+.\d]/.test(content[i])) {
        num += content[i];
        i++;
      }
      operands.push(parseFloat(num));
      continue;
    }
    if (/[A-Za-z*'"]/.test(c)) {
      let op = "";
      while (i < n && /[A-Za-z*'"]/.test(content[i])) {
        op += content[i];
        i++;
      }
      switch (op) {
        case "Tf": {
          const fn = fonts.get(lastName.replace(/^\//, ""));
          dec = fn != null ? decoderFor(fn) : (b) => b;
          break;
        }
        case "Td":
        case "TD":
          break;
        case "Tm": {
          // Tm 的第六个参数是基线 y；换行时才断行
          const nums = operands.filter((x): x is number => typeof x === "number");
          const f = nums.length >= 6 ? nums[nums.length - 1] : null;
          if (f !== null && lastBaseline !== null && Math.abs(f - lastBaseline) > 2) out += "\n";
          if (f !== null) lastBaseline = f;
          break;
        }
        case "T*":
          out += "\n";
          break;
        case "TJ":
        case "Tj":
        case "'":
        case '"':
          for (const o of operands) if (typeof o === "string" && !o.startsWith("/")) out += o;
          break;
        default:
          break;
      }
      operands.length = 0;
      continue;
    }
    i++;
  }
  return out;
}

/** 版面里的行数（换行符数），供核对跨页表用 */
export function linesOf(s: string): string[] {
  return s.split(/\n+/).map((x) => x.trim()).filter(Boolean);
}
