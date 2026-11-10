#!/usr/bin/env python3
"""
统一文档生成包装器。把模型生成文档的各种易错点（解释器路径、中文支持、
PDF CJK 字体、Excel 公式等号、PPT 中文、依赖缺失）集中在这一层处理。

所有格式统一用 markdown-it-py 解析 Markdown AST，再按格式各自渲染，
保证：
  - 粗体/斜体/行内代码/链接 → 正确转为目标格式的富文本
  - 表格 → DOCX/PDF/HTML 都渲染为真正的表格
  - 图片 → 本地路径、远程 URL、base64 都能正确嵌入

用法：
  python3 generate_document.py --format=pdf  --output=讲义.pdf --content="## 标题"
  python3 generate_document.py --format=docx --output=讲义.docx --content-file=讲义.md
  python3 generate_document.py --format=html --output=讲义.html --content-file=讲义.md

所有生成产物都会在 stdout 最后一行输出完整路径，便于调用方解析。
"""
from __future__ import annotations
import argparse, io, json, os, sys, re, tempfile, urllib.request, base64
from pathlib import Path

# ---- 中文字体注册表 ----
_FONT_REGISTERED = False
def register_cjk_fonts():
    global _FONT_REGISTERED
    if _FONT_REGISTERED:
        return True
    try:
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.cidfonts import UnicodeCIDFont
        for name in ('STSong-Light', 'MSung-Light', 'Heiti-Regular'):
            try:
                pdfmetrics.registerFont(UnicodeCIDFont(name))
            except Exception:
                pass
        _FONT_REGISTERED = True
        return True
    except Exception:
        return False


def _fmt_err(fmt: str, msg: str) -> str:
    return f"[generate_document: {fmt}] {msg}"


# ============================================================
# Markdown 解析层 —— 统一入口，用 markdown-it-py
# ============================================================
def parse_md(md_text: str):
    """解析 Markdown，返回 (mdit, tokens)。开启 table 扩展。"""
    from markdown_it import MarkdownIt
    mdit = MarkdownIt('commonmark', {'html': True}).enable('table')
    tokens = mdit.parse(md_text)
    return mdit, tokens


# ============================================================
# 图片解析层 —— 本地路径 / 远程 URL / base64 统一处理
# ============================================================
def resolve_image(src: str, base_dir: Path | None = None) -> Path | None:
    """
    把 Markdown 图片的 src 解析成一个本地可读取的文件路径。
    支持：
      - 本地绝对路径 (/tmp/xxx.png, ./fig/a.jpg)
      - 相对路径（相对于 base_dir）
      - 远程 URL（http:// https:// 开头 → 下载到临时文件）
      - base64 data URI（data:image/png;base64,xxxx → 解码到临时文件）
    找不到或下载失败返回 None。
    """
    if not src:
        return None

    # --- base64 data URI ---
    m = re.match(r'^data:image/(png|jpe?g|gif|webp|svg\+xml);base64,(.+)$', src)
    if m:
        ext = 'png' if m.group(1) == 'svg+xml' else m.group(1).replace('jpeg', 'jpg')
        try:
            data = base64.b64decode(m.group(2))
        except Exception:
            return None
        f = tempfile.NamedTemporaryFile(delete=False, suffix=f'.{ext}')
        f.write(data)
        f.close()
        return Path(f.name)

    # --- 远程 URL ---
    if src.startswith(('http://', 'https://')):
        try:
            # 从 URL 推断扩展名
            ext = os.path.splitext(src.split('?')[0])[1].lower() or '.img'
            if ext not in ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'):
                ext = '.img'
            f = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
            f.write(urllib.request.urlopen(src, timeout=15).read())
            f.close()
            return Path(f.name)
        except Exception:
            return None

    # --- 本地路径 ---
    p = Path(src)
    if not p.is_absolute() and base_dir:
        p = (base_dir / p).resolve()
    elif not p.is_absolute():
        p = p.resolve()
    if p.exists() and p.is_file():
        return p
    return None


# ============================================================
# 内联 token 遍历器 —— 统一处理 text/strong/em/code/link/image
# ============================================================
def walk_inline_children(children, handlers):
    """
    遍历 inline token 的 children，按类型调用 handlers[type](token, **kwargs)。
    handlers 需要实现：text, strong, em, code, link, image。
    """
    bold_depth = 0
    italic_depth = 0
    link_depth = 0
    link_href = None

    i = 0
    while i < len(children):
        t = children[i]
        if t.type == 'text':
            # 应用当前的嵌套样式
            style = {'bold': bold_depth > 0, 'italic': italic_depth > 0}
            handlers['text'](t.content, style)
        elif t.type == 'strong_open':
            bold_depth += 1
        elif t.type == 'strong_close':
            bold_depth = max(0, bold_depth - 1)
        elif t.type == 'em_open':
            italic_depth += 1
        elif t.type == 'em_close':
            italic_depth = max(0, italic_depth - 1)
        elif t.type == 'code_inline':
            handlers['code'](t.content)
        elif t.type == 'link_open':
            link_depth += 1
            link_href = t.attrs.get('href', '')
        elif t.type == 'link_close':
            link_depth = max(0, link_depth - 1)
            link_href = None
        elif t.type == 'image':
            handlers['image'](t.content, t.attrs.get('src', ''))
        i += 1


# ============================================================
# DOCX（python-docx）—— Markdown AST → Word
# ============================================================
def generate_docx(output: Path, content: str, spec: dict, base_dir: Path | None = None) -> Path:
    from docx import Document
    from docx.shared import Pt, RGBColor, Inches
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    doc = Document()
    title_font = spec.get('title_font', '黑体')
    body_font = spec.get('body_font', '宋体')

    def set_run_font(run, font_name, size=None, bold=None, color=None, italic=None, code=False):
        run.font.name = font_name if not code else 'Consolas'
        try:
            from docx.oxml.ns import qn
            rpr = run._element.get_or_add_rPr()
            rFonts = rpr.find(qn('w:rFonts'))
            if rFonts is None:
                rFonts = rpr.makeelement(qn('w:rFonts'), {})
                rpr.insert(0, rFonts)
            rFonts.set(qn('w:eastAsia'), font_name if not code else 'Consolas')
        except Exception:
            pass
        if size: run.font.size = Pt(size)
        if bold is not None: run.font.bold = bold
        if italic is not None: run.font.italic = italic
        if color: run.font.color.rgb = RGBColor.from_string(color)

    def add_inline_runs(paragraph, children, font_name, size):
        """把 inline token 的 children 逐个变成 paragraph 里的 runs。"""
        handlers = {
            'text': lambda text, style: (
                set_run_font(paragraph.add_run(text), font_name, size=size,
                             bold=style['bold'], italic=style['italic'])
            ),
            'code': lambda text: (
                set_run_font(paragraph.add_run(text), font_name, size=size, code=True)
            ),
            'image': lambda alt, src: (
                _docx_add_image(paragraph, src, base_dir)
            ),
        }
        walk_inline_children(children, handlers)

    def _docx_add_image(paragraph, src, base_dir):
        """尝试把 Markdown 图片插入段落。失败则在段落里写占位文本。"""
        img_path = resolve_image(src, base_dir)
        if img_path:
            try:
                paragraph.add_run().add_picture(str(img_path), width=Inches(5.0))
                return
            except Exception:
                pass
        # 兜底：写占位文本
        paragraph.add_run(f' [图片未能插入: {src}] ')

    # --- 遍历 block tokens ---
    _, tokens = parse_md(content)
    i = 0
    while i < len(tokens):
        t = tokens[i]

        # 标题
        if t.type == 'heading_open':
            level = int(t.tag[1])  # h1=1, h2=2, h3=3
            inline = tokens[i + 1]  # heading_open → inline → heading_close
            p = doc.add_paragraph()
            if level == 1:
                run = p.add_run('')
                set_run_font(run, title_font, size=22, bold=True, color='1a3a6b')
                add_inline_runs(p, inline.children or [], title_font, 22)
            elif level == 2:
                run = p.add_run('')
                set_run_font(run, title_font, size=16, bold=True, color='2a5a9b')
                add_inline_runs(p, inline.children or [], title_font, 16)
            else:
                run = p.add_run('')
                set_run_font(run, title_font, size=14, bold=True, color='3a6abf')
                add_inline_runs(p, inline.children or [], title_font, 14)
            i += 3
            continue

        # 段落
        if t.type == 'paragraph_open':
            inline = tokens[i + 1]
            p = doc.add_paragraph()
            add_inline_runs(p, inline.children or [], body_font, 11)
            i += 3
            continue

        # 无序列表
        if t.type == 'bullet_list_open':
            i += 1  # 进到第一个 list_item_open
            while i < len(tokens) and tokens[i].type != 'bullet_list_close':
                if tokens[i].type == 'list_item_open':
                    # list_item_open → paragraph_open → inline → paragraph_close → list_item_close
                    p = doc.add_paragraph(style='List Bullet')
                    j = i + 1
                    while j < len(tokens) and tokens[j].type != 'list_item_close':
                        if tokens[j].type == 'inline':
                            add_inline_runs(p, tokens[j].children or [], body_font, 11)
                        j += 1
                    i = j + 1
                else:
                    i += 1
            i += 1  # skip bullet_list_close
            continue

        # 有序列表
        if t.type == 'ordered_list_open':
            i += 1
            while i < len(tokens) and tokens[i].type != 'ordered_list_close':
                if tokens[i].type == 'list_item_open':
                    p = doc.add_paragraph(style='List Number')
                    j = i + 1
                    while j < len(tokens) and tokens[j].type != 'list_item_close':
                        if tokens[j].type == 'inline':
                            add_inline_runs(p, tokens[j].children or [], body_font, 11)
                        j += 1
                    i = j + 1
                else:
                    i += 1
            i += 1
            continue

        # 表格
        if t.type == 'table_open':
            table_tokens = []
            i += 1
            while i < len(tokens) and tokens[i].type != 'table_close':
                table_tokens.append(tokens[i])
                i += 1
            # 解析表格内容
            rows = []
            cur_row = []
            cur_cell_inline = None
            for tt in table_tokens:
                if tt.type == 'tr_open':
                    cur_row = []
                elif tt.type in ('th_open', 'td_open'):
                    cur_cell_inline = None
                elif tt.type == 'inline':
                    cur_cell_inline = tt
                elif tt.type in ('th_close', 'td_close'):
                    # 收集 cell 的完整 inline 内容
                    cur_row.append(cur_cell_inline)
                elif tt.type == 'tr_close':
                    rows.append(cur_row)

            if rows:
                # 找最大列数
                max_cols = max(len(r) for r in rows)
                # 创建表格
                tbl = doc.add_table(rows=len(rows), cols=max_cols)
                tbl.style = 'Table Grid'
                for r_idx, row in enumerate(rows):
                    for c_idx, cell_inline in enumerate(row):
                        if c_idx < max_cols:
                            cell = tbl.rows[r_idx].cells[c_idx]
                            cell.text = ''  # 清空默认内容
                            if cell_inline:
                                p = cell.paragraphs[0]
                                add_inline_runs(p, cell_inline.children or [], body_font, 10)
            i += 1
            continue

        # 分隔线
        if t.type == 'hr':
            doc.add_paragraph('─' * 30)
            i += 1
            continue

        # 忽略 blockquote、code_block 等暂不支持的
        i += 1

    doc.save(str(output))
    return output


# ============================================================
# PDF（reportlab）—— Markdown AST → PDF
# ============================================================
def generate_pdf(output: Path, content: str, spec: dict, base_dir: Path | None = None) -> Path:
    register_cjk_fonts()
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table as RlTable, TableStyle, PageBreak, Image as RlImage
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib import colors

    base_font = 'STSong-Light'

    title_style = ParagraphStyle('CNTitle', fontName=base_font, fontSize=spec.get('title_size', 22),
                                  leading=spec.get('title_size', 22) * 1.4, alignment=TA_CENTER, spaceAfter=18)
    h1_style = ParagraphStyle('CNH1', fontName=base_font, fontSize=spec.get('h1_size', 16),
                               leading=spec.get('h1_size', 16) * 1.4, spaceBefore=14, spaceAfter=8,
                               textColor=colors.HexColor('#1a3a6b'))
    h2_style = ParagraphStyle('CNH2', fontName=base_font, fontSize=spec.get('h2_size', 13),
                               leading=spec.get('h2_size', 13) * 1.4, spaceBefore=10, spaceAfter=6,
                               textColor=colors.HexColor('#2a5a9b'))
    body_style = ParagraphStyle('CNBody', fontName=base_font, fontSize=spec.get('body_size', 11),
                                 leading=spec.get('body_size', 11) * 1.5, spaceAfter=6)

    def escape_xml(s: str) -> str:
        return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

    def inline_to_xml(children) -> str:
        """把 inline children 转成 reportlab Paragraph 能吃的 XML 字符串。"""
        parts = []
        bold_depth = 0
        italic_depth = 0
        # 预扫描：嵌套的 bold/italic 需要正确配对
        stack = []  # ('b' or 'i', depth)
        i = 0
        while i < len(children):
            t = children[i]
            if t.type == 'text':
                open_tags = ''.join(f'<{tag}>' for tag, _ in stack)
                close_tags = ''.join(f'</{tag}>' for tag, _ in reversed(stack))
                parts.append(f'{open_tags}{escape_xml(t.content)}{close_tags}')
            elif t.type == 'strong_open':
                stack.append(('b', bold_depth))
            elif t.type == 'strong_close':
                if stack and stack[-1][0] == 'b':
                    stack.pop()
            elif t.type == 'em_open':
                stack.append(('i', italic_depth))
            elif t.type == 'em_close':
                if stack and stack[-1][0] == 'i':
                    stack.pop()
            elif t.type == 'code_inline':
                parts.append(f'<font face="Courier">{escape_xml(t.content)}</font>')
            elif t.type == 'link_open':
                parts.append(f'<link href="{escape_xml(t.attrs.get("href", ""))}" color="blue">')
            elif t.type == 'link_close':
                parts.append('</link>')
            elif t.type == 'image':
                img_path = resolve_image(t.attrs.get('src', ''), base_dir)
                if img_path:
                    # 先在 story 里占位
                    parts.append('')
                else:
                    parts.append(f'[{escape_xml(t.content)}]')
            i += 1
        return ''.join(parts)

    story = []
    _, tokens = parse_md(content)
    i = 0
    while i < len(tokens):
        t = tokens[i]

        if t.type == 'heading_open':
            level = int(t.tag[1])
            inline = tokens[i + 1]
            xml = inline_to_xml(inline.children or [])
            if level == 1:
                story.append(Paragraph(xml or '', title_style))
            elif level == 2:
                story.append(Paragraph(xml or '', h1_style))
            else:
                story.append(Paragraph(xml or '', h2_style))
            i += 3
            continue

        if t.type == 'paragraph_open':
            inline = tokens[i + 1]
            xml = inline_to_xml(inline.children or [])
            story.append(Paragraph(xml or '', body_style))
            # 检查这段里有没有 image token
            for c in inline.children or []:
                if c.type == 'image':
                    img_path = resolve_image(c.attrs.get('src', ''), base_dir)
                    if img_path:
                        try:
                            story.append(RlImage(str(img_path), width=380, height=250))
                            story.append(Spacer(1, 8))
                        except Exception:
                            pass
            i += 3
            continue

        if t.type == 'bullet_list_open':
            i += 1
            while i < len(tokens) and tokens[i].type != 'bullet_list_close':
                if tokens[i].type == 'list_item_open':
                    j = i + 1
                    while j < len(tokens) and tokens[j].type != 'list_item_close':
                        if tokens[j].type == 'inline':
                            xml = inline_to_xml(tokens[j].children or [])
                            story.append(Paragraph('• ' + (xml or ''), body_style))
                        j += 1
                    i = j + 1
                else:
                    i += 1
            i += 1
            continue

        if t.type == 'ordered_list_open':
            idx = 1
            i += 1
            while i < len(tokens) and tokens[i].type != 'ordered_list_close':
                if tokens[i].type == 'list_item_open':
                    j = i + 1
                    while j < len(tokens) and tokens[j].type != 'list_item_close':
                        if tokens[j].type == 'inline':
                            xml = inline_to_xml(tokens[j].children or [])
                            story.append(Paragraph(f'{idx}. ' + (xml or ''), body_style))
                            idx += 1
                        j += 1
                    i = j + 1
                else:
                    i += 1
            i += 1
            continue

        if t.type == 'table_open':
            table_tokens = []
            i += 1
            while i < len(tokens) and tokens[i].type != 'table_close':
                table_tokens.append(tokens[i])
                i += 1
            rows = []
            cur_row = []
            cur_cell = None
            for tt in table_tokens:
                if tt.type == 'tr_open':
                    cur_row = []
                elif tt.type in ('th_open', 'td_open'):
                    cur_cell = None
                elif tt.type == 'inline':
                    cur_cell = inline_to_xml(tt.children or [])
                elif tt.type in ('th_close', 'td_close'):
                    cur_row.append(cur_cell or '')
                elif tt.type == 'tr_close':
                    rows.append(cur_row)
            if rows:
                max_cols = max(len(r) for r in rows)
                padded = [r + [''] * (max_cols - len(r)) for r in rows]
                data = [[Paragraph(c, body_style) for c in r] for r in padded]
                tbl = RlTable(data, repeatRows=1)
                tbl.setStyle(TableStyle([
                    ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#E8EEF7')),
                    ('TEXTCOLOR', (0, 0), (-1, 0), colors.HexColor('#1a3a6b')),
                    ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
                    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                ]))
                story.append(tbl)
                story.append(Spacer(1, 8))
            i += 1
            continue

        if t.type == 'hr':
            story.append(Spacer(1, 8))
            i += 1
            continue

        i += 1

    doc = SimpleDocTemplate(str(output), pagesize=A4,
                            title=spec.get('title', output.stem),
                            author=spec.get('author', ''),
                            margins=(56, 56, 56, 56))
    doc.build(story)
    return output


# ============================================================
# HTML —— 直接让 markdown-it-py 渲染，再修图片 src
# ============================================================
def generate_html(output: Path, content: str, spec: dict, base_dir: Path | None = None) -> Path:
    import html as html_mod
    from markdown_it import MarkdownIt
    mdit = MarkdownIt('commonmark', {'html': True}).enable('table')

    # 先拿到原始 tokens，处理图片
    tokens = mdit.parse(content)
    # 渲染 HTML，但把图片 src 替换成 resolved 的本地路径（用 file:// 或 base64）
    rendered = mdit.render(content)

    # 替换图片 src：<img src="xxx" ...>
    def fix_img_src(m):
        prefix = m.group(1)
        src = m.group(2)
        suffix = m.group(3)
        img_path = resolve_image(src, base_dir)
        if img_path:
            # 本地路径 → file:// URL
            new_src = f'file://{img_path}' if img_path.is_file() else src
            return f'<img {prefix}src="{new_src}"{suffix}>'
        return m.group(0)  # 保持原样

    rendered = re.sub(r'<img ([^>]*?)src="([^"]+)"([^>]*)>', fix_img_src, rendered)

    title = spec.get('title', output.stem)
    html_doc = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>{html_mod.escape(title)}</title>
<style>
body{{font-family:'Noto Sans CJK SC','Microsoft YaHei','Segoe UI',sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.8;color:#222}}
h1{{color:#1a3a6b;border-bottom:2px solid #1a3a6b;padding-bottom:6px}}
h2{{color:#2a5a9b;margin-top:28px}}
h3{{color:#3a6abf}}
table{{border-collapse:collapse;margin:12px 0}}
th,td{{border:1px solid #ccc;padding:6px 12px;text-align:left}}
th{{background:#E8EEF7;color:#1a3a6b}}
img{{max-width:100%;height:auto;margin:12px 0}}
pre{{background:#f5f5f5;padding:12px;border-radius:4px;overflow-x:auto}}
code{{background:#f0f0f0;padding:1px 4px;border-radius:3px;font-family:Consolas,monospace}}
pre code{{background:none;padding:0}}
blockquote{{border-left:4px solid #2a5a9b;margin:12px 0;padding:4px 16px;color:#555;background:#f8f9fc}}
hr{{border:none;border-top:1px solid #ccc;margin:24px 0}}
</style>
</head>
<body>{rendered}</body>
</html>"""
    output.write_text(html_doc, encoding='utf-8')
    return output


# ============================================================
# PPTX（python-pptx）—— Markdown AST → 幻灯片
# ============================================================
def generate_pptx(output: Path, content: str, spec: dict, base_dir: Path | None = None) -> Path:
    from pptx import Presentation
    from pptx.util import Inches, Pt, Emu
    from pptx.dml.color import RGBColor

    prs = Presentation()
    prs.slide_width = Inches(13.33)
    prs.slide_height = Inches(7.5)
    title_font = '微软雅黑'
    body_font = '微软雅黑'

    # 解析 Markdown，按 h1/h2 切幻灯片
    _, tokens = parse_md(content)
    slides_data = []
    cur_title = output.stem
    cur_blocks = []

    def flush_slide():
        if cur_title or cur_blocks:
            slides_data.append({'title': cur_title, 'blocks': list(cur_blocks)})
            cur_blocks.clear()

    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t.type == 'heading_open':
            level = int(t.tag[1])
            inline = tokens[i + 1]
            heading_text = inline.content if inline else ''
            if level <= 2:
                # 新幻灯片
                flush_slide()
                cur_title = heading_text
            else:
                cur_blocks.append(('h3', heading_text))
            i += 3
        elif t.type == 'paragraph_open':
            inline = tokens[i + 1]
            # 检查有没有图片
            has_image = any(c.type == 'image' for c in (inline.children or []))
            if has_image:
                for c in (inline.children or []):
                    if c.type == 'image':
                        img_path = resolve_image(c.attrs.get('src', ''), base_dir)
                        if img_path:
                            cur_blocks.append(('image', str(img_path)))
                        elif c.content:
                            cur_blocks.append(('text', c.content))
            else:
                cur_blocks.append(('text', inline.content if inline else ''))
            i += 3
        elif t.type == 'bullet_list_open':
            items = []
            i += 1
            while i < len(tokens) and tokens[i].type != 'bullet_list_close':
                if tokens[i].type == 'list_item_open':
                    j = i + 1
                    while j < len(tokens) and tokens[j].type != 'list_item_close':
                        if tokens[j].type == 'inline':
                            items.append(tokens[j].content)
                        j += 1
                    i = j + 1
                else:
                    i += 1
            cur_blocks.append(('bullet_list', items))
            i += 1
        elif t.type == 'table_open':
            table_rows = []
            cur_row = []
            i += 1
            while i < len(tokens) and tokens[i].type != 'table_close':
                if tokens[i].type == 'tr_open':
                    cur_row = []
                elif tokens[i].type == 'inline':
                    cur_row.append(tokens[i].content)
                elif tokens[i].type == 'tr_close':
                    table_rows.append(cur_row)
                i += 1
            cur_blocks.append(('table', table_rows))
            i += 1
        else:
            i += 1

    flush_slide()

    # 生成幻灯片
    for sd in slides_data or [{'title': cur_title, 'blocks': cur_blocks}]:
        slide = prs.slides.add_slide(prs.slide_layouts[5])  # Blank layout
        # 标题
        txBox = slide.shapes.add_textbox(Inches(0.5), Inches(0.3), Inches(12.3), Inches(0.8))
        tf = txBox.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        run = p.add_run()
        run.text = sd['title']
        run.font.name = title_font
        run.font.size = Pt(32)
        run.font.bold = True
        run.font.color.rgb = RGBColor.from_string('#1a3a6b')

        # 内容
        top = 1.3
        max_top = 6.5
        for btype, bdata in sd['blocks']:
            if top >= max_top:
                break
            if btype == 'text':
                txBox = slide.shapes.add_textbox(Inches(0.5), Inches(top), Inches(12.3), Inches(0.4))
                tf = txBox.text_frame
                tf.word_wrap = True
                run = tf.paragraphs[0].add_run()
                run.text = bdata
                run.font.name = body_font
                run.font.size = Pt(18)
                top += 0.5
            elif btype == 'bullet_list':
                for item in bdata:
                    if top >= max_top:
                        break
                    txBox = slide.shapes.add_textbox(Inches(0.8), Inches(top), Inches(11.5), Inches(0.4))
                    tf = txBox.text_frame
                    tf.word_wrap = True
                    run = tf.paragraphs[0].add_run()
                    run.text = '• ' + item
                    run.font.name = body_font
                    run.font.size = Pt(16)
                    top += 0.4
            elif btype == 'image':
                if top + 3.5 <= max_top:
                    try:
                        slide.shapes.add_picture(bdata, Inches(0.5), Inches(top), width=Inches(8), height=Inches(3.5))
                        top += 3.7
                    except Exception:
                        top += 0.4
            elif btype == 'table':
                if bdata:
                    n_rows = len(bdata)
                    n_cols = max(len(r) for r in bdata) if bdata else 1
                    if top + min(n_rows * 0.4, 4.0) <= max_top:
                        try:
                            tbl_shape = slide.shapes.add_table(n_rows, n_cols, Inches(0.5), Inches(top), Inches(12.3), Inches(min(n_rows * 0.4, 4.0)))
                            table = tbl_shape.table
                            for ri, row in enumerate(bdata):
                                for ci, cell_text in enumerate(row):
                                    if ci < n_cols:
                                        table.cell(ri, ci).text = cell_text
                            top += min(n_rows * 0.4, 4.0) + 0.3
                        except Exception:
                            top += 0.4

    prs.save(str(output))
    return output


# ============================================================
# Markdown —— 直接写文件
# ============================================================
def generate_md(output: Path, content: str, spec: dict) -> Path:
    output.write_text(content, encoding='utf-8')
    return output


# ============================================================
# XLSX（openpyxl）—— 从 spec dict 创建多张表（不涉及 Markdown 渲染）
# ============================================================
def generate_xlsx(output: Path, content: str, spec: dict) -> Path:
    from openpyxl import Workbook
    from openpyxl.styles import Font, Alignment, PatternFill, Border, Side

    wb = Workbook()
    sheets = spec.get('sheets') if isinstance(spec, dict) and spec.get('sheets') else None

    if not sheets:
        ws = wb.active
        ws.title = output.stem[:31] or 'Sheet1'
        for r_idx, row in enumerate(content.split('\n'), 1):
            for c_idx, val in enumerate(row.split('\t'), 1):
                ws.cell(row=r_idx, column=c_idx, value=val)
        wb.save(str(output))
        return output

    for s_def in sheets:
        name = str(s_def.get('name', f'Sheet{sheets.index(s_def)+1}'))[:31]
        ws = wb.create_sheet(title=name) if wb.active.title != name else wb.active
        rows = s_def.get('rows', [])
        for r_idx, row in enumerate(rows, 1):
            for c_idx, cell in enumerate(row, 1):
                c = ws.cell(row=r_idx, column=c_idx, value=cell)
                if r_idx == 1:
                    c.font = Font(bold=True, name='微软雅黑', size=11)
                    c.fill = PatternFill('solid', fgColor='DCE4F2')
                    c.alignment = Alignment(horizontal='center')

    wb.save(str(output))
    return output


FORMAT_HANDLERS = {
    'pdf':   generate_pdf,
    'docx':  generate_docx,
    'xlsx':  generate_xlsx,
    'pptx':  generate_pptx,
    'md':    generate_md,
    'html':  generate_html,
    'markdown': generate_md,
}


def load_spec(path: str | None) -> dict:
    if not path: return {}
    p = Path(path)
    if not p.exists(): return {}
    text = p.read_text(encoding='utf-8')
    try: return json.loads(text)
    except Exception:
        try:
            import yaml
            return yaml.safe_load(text) or {}
        except Exception:
            return {}


def main():
    parser = argparse.ArgumentParser(description='统一文档生成包装器')
    parser.add_argument('--format', '-f', required=True,
                        choices=list(FORMAT_HANDLERS.keys()),
                        help='目标格式：pdf/docx/xlsx/pptx/md/html')
    parser.add_argument('--output', '-o', required=True, help='输出文件路径')
    parser.add_argument('--content', '-c', default='', help='内联 Markdown/CSV/文本内容')
    parser.add_argument('--content-file', help='从文件读取内容（比 --content 适合长文本）')
    parser.add_argument('--spec', '-s', help='JSON/YAML spec 文件（复杂文档如多 sheet Excel、多页 PPT）')
    parser.add_argument('--title', help='文档标题（写进 spec 里也可以）')
    args = parser.parse_args()

    content = args.content
    base_dir = None
    if args.content_file:
        content_path = Path(args.content_file).expanduser().resolve()
        content = content_path.read_text(encoding='utf-8')
        base_dir = content_path.parent
    if not content:
        print(_fmt_err(args.format, '缺少内容：请传 --content 或 --content-file'), file=sys.stderr)
        sys.exit(1)

    spec = load_spec(args.spec)
    if args.title and isinstance(spec, dict):
        spec.setdefault('title', args.title)

    fmt = args.format
    out_path = Path(args.output).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    handler = FORMAT_HANDLERS[fmt]
    try:
        # 带 Markdown 渲染的格式接收 base_dir，用于解析相对路径图片
        if fmt in ('pdf', 'docx', 'html', 'pptx'):
            result = handler(out_path, content or '', spec or {}, base_dir)
        else:
            result = handler(out_path, content or '', spec or {})
    except ImportError as e:
        print(_fmt_err(fmt, f"缺少依赖：{e.name}。请先 pip install {e.name}"), file=sys.stderr)
        sys.exit(2)
    except Exception as e:
        print(_fmt_err(fmt, f"生成失败：{type(e).__name__}: {e}"), file=sys.stderr)
        sys.exit(3)

    if not result.exists():
        print(_fmt_err(fmt, f"生成后文件不存在：{result}"), file=sys.stderr)
        sys.exit(4)

    # 末尾只输出文件的绝对路径，供解析器抓
    print(str(result))


if __name__ == '__main__':
    main()
