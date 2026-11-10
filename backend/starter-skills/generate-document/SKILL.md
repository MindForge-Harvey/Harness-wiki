---
name: generate-document
description: 把整理好的内容生成 Word/Excel/PPT/PDF/Markdown/HTML 文档。用户要求导出、生成报告/表格/演示文稿/PDF，或需要把内容转成正式文档格式时使用。
metadata:
  display_name: 生成文档
---

# 生成文档

需要把内容导出为正式文档（Word / Excel / PPT / PDF / Markdown / HTML）时，严格按下面的步骤执行。

## 第一步：写 Markdown 内容文件

用 write 工具把完整正文写入一个 `.md` 文件。章节标题、段落、列表都用 Markdown 格式，内容要完整可直接交付，不要写「此处省略」。

## 第二步：用统一脚本生成目标格式

```bash
bash backend/scripts/run_docgen.sh python3 backend/scripts/generate_document.py --format=<格式> --output=<文件名> --content-file=<上一步的 .md 文件> --title=<文档标题>
```

格式取值：`pdf` / `docx` / `xlsx` / `pptx` / `md` / `html`。

脚本会自动处理 PDF 中文字体（STSong-Light）、Word 字体继承、Excel 表头样式等易错点。成功后**只输出一行绝对路径**，不要再 ls 或 cat 去验证。

## 第三步：仅复杂场景才自写脚本

当 Markdown → 目标格式的简单映射表达不了需求时（多 sheet Excel、多页 PPT 要不同样式、PDF 多栏/插图、Excel 公式等），才自己写 Python 脚本，必须遵守：

- 解释器只用 python3
- PDF 用 reportlab 时先注册 STSong-Light CID 字体：
  `from reportlab.pdfbase import pdfmetrics; from reportlab.pdfbase.cidfonts import UnicodeCIDFont; pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))`
- 脚本末尾只 print 输出文件绝对路径
- 不 rm 任何已有文件

写完脚本后用防护层执行：

```bash
bash backend/scripts/run_docgen.sh python3 <脚本名>.py
```

所有文档生成命令都必须以 `bash backend/scripts/run_docgen.sh` 开头 —— 它会自动把 python 改成 python3、拦截 rm -rf、失败时给出原因。不要直接用裸 python 执行，也不要探测环境（which / import 检查 / python3 --version 一律跳过）。

详细格式说明见 `backend/scripts/docgen-reference.md`。
