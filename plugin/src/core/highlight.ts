/** 极简语法高亮：只认字符串、注释、数字、关键字，输出不改变原文 */
const KEYWORDS: Record<string, string[]> = {
  js: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "new", "await", "async", "import", "export", "from", "default", "try", "catch", "throw", "typeof", "in", "of", "this", "null", "undefined", "true", "false"],
  ts: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "new", "await", "async", "import", "export", "from", "default", "try", "catch", "throw", "typeof", "interface", "type", "extends", "implements", "public", "private", "readonly", "null", "undefined", "true", "false"],
  py: ["def", "return", "if", "elif", "else", "for", "while", "class", "import", "from", "as", "try", "except", "raise", "with", "lambda", "None", "True", "False", "and", "or", "not", "in", "is", "yield", "async", "await"],
  bash: ["if", "then", "else", "fi", "for", "do", "done", "while", "case", "esac", "function", "export", "local", "return", "echo", "cd", "set"],
  json: ["true", "false", "null"],
  sql: ["select", "from", "where", "join", "left", "right", "on", "group", "by", "order", "insert", "update", "delete", "create", "table", "and", "or", "as"],
  yaml: ["true", "false", "null"],
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface HlOptions {
  lang?: string;
}

/** 返回安全 HTML（已转义）；同一行内不做跨行状态 */
export function highlightLine(line: string, opts: HlOptions = {}): string {
  const lang = (opts.lang ?? "").toLowerCase();
  const kws = KEYWORDS[lang] ?? KEYWORDS.ts;
  const kwRe = new RegExp(`^(?:${kws.join("|")})$`);
  const commentStart = lang === "py" || lang === "bash" || lang === "yaml" ? "#" : "//";
  let out = "";
  let i = 0;
  const push = (cls: string, text: string) => {
    out += cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text);
  };
  while (i < line.length) {
    const rest = line.slice(i);
    // 注释
    if (rest.startsWith(commentStart) && !rest.startsWith(commentStart + commentStart)) {
      push("ntb-hl-c", rest);
      break;
    }
    // 字符串
    const q = /^(['"`])/.exec(rest);
    if (q) {
      const quote = q[1];
      let j = 1;
      while (j < rest.length && rest[j] !== quote) {
        if (rest[j] === "\\") j++;
        j++;
      }
      push("ntb-hl-s", rest.slice(0, j + 1));
      i += j + 1;
      continue;
    }
    // 数字
    const num = /^\d+(?:\.\d+)?/.exec(rest);
    if (num) {
      push("ntb-hl-n", num[0]);
      i += num[0].length;
      continue;
    }
    // 标识符 / 关键字 / 函数调用
    const ident = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (ident) {
      const w = ident[0];
      if (kwRe.test(w)) push("ntb-hl-k", w);
      else if (rest.slice(w.length).startsWith("(")) push("ntb-hl-f", w);
      else push("", w);
      i += w.length;
      continue;
    }
    push("", rest[0]);
    i++;
  }
  return out;
}
