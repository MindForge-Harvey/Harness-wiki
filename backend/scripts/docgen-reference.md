# 文档生成 reference：各格式的 spec 字段说明

所有格式都优先走 `python3 generate_document.py --format=X --output=Y --content="Markdown 内容"` 的简单路径。
只有当简单路径表达不了复杂布局（多 sheet Excel、多页 PPT 各页要不同标题、复杂表格）时才用 `--spec`。

所有 spec 支持 JSON 或 YAML；最终输出路径的**最后一行 stdout**就是绝对路径，解析器直接抓那一行即可。

---

## PDF（--format=pdf）

简单路径：`--content` 就是 Markdown（# 标题 / ## 章节 / 段落 / - 列表 都支持）。
内部自动注册 STSong-Light 中文 CID 字体，不会出现方框缺字。

spec 可选项：
```yaml
title: 薪酬管理培训讲义    # 文档标题（写进元数据）
author: 知识库运营助手      # 作者
title_size: 22             # 封面/一级标题字号
h1_size: 16                # 二级标题字号
body_size: 11              # 正文字号
```

---

## DOCX（--format=docx）

简单路径：`--content` 就是 Markdown。内部设置 eastAsia 字体为「黑体」标题 / 「宋体」正文。

spec 可选项：
```yaml
title_font: 黑体
body_font: 宋体
```

---

## XLSX（--format=xlsx）

简单路径：`--content` 是 Tab 分隔的表格，自动放进单张 Sheet。
复杂路径：`--spec` 多 sheet。

```yaml
sheets:
  - name: 基础信息
    rows:
      - ["工号", "姓名", "部门"]
      - ["001", "张三", "研发"]
      - ["002", "李四", "产品"]
  - name: 薪酬汇总
    rows:
      - ["月份", "基本工资", "绩效"]
      - ["11月", 8000, 2000]
```

规则：
- 第一行自动加粗、背景浅蓝、居中（表头样式）
- 单元格值按类型自动推断（数字不加引号）

---

## PPTX（--format=pptx）

简单路径：`--content` 是 Markdown，每遇到一个一级/二级标题就自动翻页。
复杂路径：`--spec` 指定每页内容。

```yaml
slides:
  - title: 薪酬管理概述
    body: |
      • 薪酬结构设计
      • 岗位职级体系
      • 绩效与奖金关联
  - title: 常见问题
    body: |
      • Q1：职级如何评定？
      • Q2：年终奖计算方式？
```

---

## MD / HTML

`--content` 即正文，无需 spec。HTML 自动套模板（Noto Sans CJK 字体 + 居中样式）。

---

## 什么时候绕过这个脚本？

当脚本的简单 Markdown → 格式映射满足不了需求时（比如 PPT 要插入图片动画、PDF 要复杂多栏布局、Excel 要写复杂公式），可以自己写 Python 脚本。但必须遵守：

1. 解释器只用 `python3`（别写裸 `python`，宿主上可能没装）
2. PDF 用 reportlab 时必须先 `from reportlab.pdfbase import pdfmetrics; from reportlab.pdfbase.cidfonts import UnicodeCIDFont; pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'));`，否则中文字变方框
3. 脚本末尾 `print(abs_output_path)`，**只**输出这一行绝对路径
4. 不要 `rm` 删除任何已存在的文件或脚本自己
