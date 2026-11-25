#!/bin/zsh
# 双击这个文件，就把笔记库排成 A4 讲义。
# 不用敲命令；跑完会自动打开成品文件夹。

cd "$(dirname "$0")" || exit 1

echo "──────────────────────────────────────"
echo "  笔记 → 成书"
echo "──────────────────────────────────────"

# 没有终端（被脚本调用）时不要卡在按键上
pause() { [ -t 0 ] && read -k1; return 0; }

# 1. 找一个装了 reportlab 的 python（系统自带的 3.9 通常没装）
PY=""
for c in \
  /Users/liufenghua/.workbuddy/binaries/python/versions/3.13.12/bin/python3 \
  /opt/homebrew/bin/python3 \
  /usr/local/bin/python3 \
  python3
do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c "import reportlab, pymupdf, pypinyin" >/dev/null 2>&1; then
    PY="$c"; break
  fi
done

if [ -z "$PY" ]; then
  echo "找不到依赖齐全的 Python（需要 reportlab / pymupdf / pypinyin）。先装："
  echo
  echo "    pip3 install --user reportlab pymupdf pypinyin"
  echo
  echo "（按任意键关闭）"; pause; exit 1
fi

# 2. 笔记库：优先用 iCloud 里那套，没有就用仓库自带的示例
VAULT="${NOTES_VAULT:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/高中笔记}"
[ -d "$VAULT" ] || VAULT="examples/demo"

# 3. 成品输出到桌面
OUT="${NOTES_OUT:-$HOME/Desktop/打印本}"

echo "Python：$PY"
echo "笔记库：$VAULT"
echo "成品目录：$OUT"
echo

"$PY" bookgen.py --vault "$VAULT" --outdir "$OUT"
rc=$?

echo
if [ $rc -eq 0 ]; then
  echo "✅ 排完了，正在打开成品文件夹"
  open "$OUT"
else
  echo "❌ 中途出错（退出码 $rc），上面的报错往上翻"
fi
echo
echo "（按任意键关闭窗口）"
pause
