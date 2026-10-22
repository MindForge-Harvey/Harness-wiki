/**
 * 知识库引用文件定位：把检索结果里的引用文件名解析为 LightRAG 原料区里的原始文件。
 *
 * 引用名是入库时的 file_path（通常不带目录前缀），而原料区文件可能带类别前缀
 * （如 `人力资源管理_员工管理_<引用名>`），因此按「精确名 → 前缀后缀名」两级查找。
 * 只允许读取原料区根目录及其 __parsed__ 子目录内的普通文件，挡 path 穿越。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 可在线预览的原始文件类型（与前端 DocumentPreview 的能力一致）。 */
const KINDS = new Map([
  ['docx', 'Word'],
  ['xlsx', 'Excel'],
  ['xls', 'Excel'],
  ['pptx', 'PPT'],
  ['ppt', 'PPT'],
  ['pdf', 'PDF'],
  ['md', 'Markdown'],
  ['txt', '文本'],
])

const PARSED_DIR = '__parsed__'

/** 解析结果是否仍落在原料区根目录内（防路径穿越的统一判定）。 */
function inside(root, resolved) {
  const rel = path.relative(root, resolved)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

function statFile(file) {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() ? stat : null
  } catch {
    return null
  }
}

/**
 * 创建引用文件定位器。
 * @param {string|null|undefined} inputsDir LightRAG 原料区根目录（KB_LIGHTRAG_INPUTS_DIR）
 * @returns {{
 *   enabled: boolean,
 *   resolve: (name: string) => ({ path: string, name: string, ext: string, kind: string, size: number, mtime: number } | null),
 *   mime: (ext: string) => string,
 * }}
 */
export function createKbSourceStore(inputsDir) {
  const root = inputsDir ? path.resolve(inputsDir) : null
  const enabled = Boolean(root && fs.existsSync(root))

  /** 纯文件名：引用名带目录时按 basename 处理，其余情况只接受原料区内的文件名。 */
  const basename = (name) => path.basename(String(name || '').replaceAll('\\', '/'))

  function entry(file) {
    if (!file) return null
    const name = path.basename(file)
    const ext = path.extname(name).slice(1).toLowerCase()
    const kind = KINDS.get(ext)
    if (!kind) return null
    const stat = statFile(file)
    if (!stat || !inside(root, path.resolve(file))) return null
    return { path: file, name, ext, kind, size: stat.size, mtime: Math.round(stat.mtimeMs) }
  }

  function resolve(name) {
    if (!enabled) return null
    const base = basename(name)
    if (!base || base === '.' || base === '..') return null
    const dirs = [root, path.join(root, PARSED_DIR)]
    // 1. 精确文件名（引用名与原料区文件名一致）。
    for (const dir of dirs) {
      const hit = entry(path.join(dir, base))
      if (hit) return hit
    }
    // 2. 带类别前缀的文件（<前缀>_<引用名>），多个候选按名称排序取第一个。
    const suffix = '_' + base
    for (const dir of dirs) {
      let names = []
      try {
        names = fs.readdirSync(dir, { withFileTypes: true })
          .filter((item) => item.isFile() && item.name.endsWith(suffix))
          .map((item) => item.name)
          .sort()
      } catch {
        continue
      }
      if (names.length) return entry(path.join(dir, names[0]))
    }
    return null
  }

  /** 原始文件的响应内容类型：浏览器按扩展名解析预览与下载。 */
  function mime(ext) {
    switch (ext) {
      case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      case 'xls': return 'application/vnd.ms-excel'
      case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      case 'ppt': return 'application/vnd.ms-powerpoint'
      case 'pdf': return 'application/pdf'
      case 'md': return 'text/markdown; charset=utf-8'
      default: return 'text/plain; charset=utf-8'
    }
  }

  return { enabled, resolve, mime }
}
