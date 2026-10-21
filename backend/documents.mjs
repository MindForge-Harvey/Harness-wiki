import fs from 'node:fs'
import path from 'node:path'

/** 可展示和下载的文档类型（扩展名 → 展示分类）。只收真正的成品文档，配置和代码文件不进面板。 */
const KINDS = new Map([
  ['doc', 'Word'], ['docx', 'Word'],
  ['xls', 'Excel'], ['xlsx', 'Excel'], ['csv', 'Excel'],
  ['ppt', 'PPT'], ['pptx', 'PPT'],
  ['pdf', 'PDF'],
  ['md', 'Markdown'],
  // 单文件 HTML 演示文稿（PPT Page 等技能的产物）连同它引用的同目录资源一起可预览。
  ['html', 'HTML'], ['htm', 'HTML'],
])

/** HTML 预览时允许一并读取的伴随资源类型。 */
const ASSET_TYPES = new Set(['html', 'htm', 'css', 'js', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'woff', 'woff2', 'ttf', 'ico'])

/** 工作区里不参与扫描的目录：依赖、版本库、运行时数据与构建产物。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.spool', '.run', 'dist', 'coverage', 'dsh'])

const badRequest = message => Object.assign(new Error(message), { status: 400 })

/**
 * 扫描 harness 工作区里的文档产物。
 * @param {string} root 工作区根目录（dsh 子进程的 cwd）
 * @param {{ maxDepth?: number, limit?: number }} options 扫描深度与返回条数上限
 */
export function createDocumentStore(root, { maxDepth = 4, limit = 100 } = {}) {
  const base = path.resolve(root)

  function scan() {
    const found = []
    const walk = (dir, depth) => {
      if (depth > maxDepth || found.length >= limit * 4) return
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
          walk(full, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        const ext = path.extname(entry.name).slice(1).toLowerCase()
        const kind = KINDS.get(ext)
        if (!kind) continue
        let stat
        try { stat = fs.statSync(full) } catch { continue }
        found.push({
          path: path.relative(base, full).split(path.sep).join('/'),
          name: entry.name,
          ext,
          kind,
          size: stat.size,
          mtime: Math.round(stat.mtimeMs),
        })
      }
    }
    walk(base, 0)
    return found.sort((a, b) => b.mtime - a.mtime)
  }

  /** 列出 sinceMs 之后生成或修改的文档，按修改时间倒序。 */
  function list(sinceMs = 0) {
    return scan().filter(doc => doc.mtime >= sinceMs).slice(0, limit)
  }

  /** 工作区文档的版本快照（路径 → 修改时间与大小），用于判断一轮里产生了哪些文档。 */
  function snapshot() {
    return new Map(scan().map(doc => [doc.path, `${doc.mtime}:${doc.size}`]))
  }

  /** 与快照对比，返回本轮新增或修改过的文档。 */
  function changedSince(before) {
    return scan().filter(doc => before.get(doc.path) !== `${doc.mtime}:${doc.size}`)
  }

  /** 把请求里的相对路径解析为工作区内的文档文件，越界或类型不符直接拒绝。 */
  function resolve(relative) {
    return locate(relative, ext => KINDS.has(ext))
  }

  /** 解析 HTML 预览页及其伴随资源（图片、样式、脚本），同样限制在工作区内。 */
  function resolveAsset(relative) {
    return locate(relative, ext => ASSET_TYPES.has(ext))
  }

  function locate(relative, accept) {
    if (typeof relative !== 'string' || !relative) throw badRequest('缺少文档路径')
    const normalized = relative.replaceAll('\\', '/')
    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.split('/').includes('..')) {
      throw badRequest('文档路径无效')
    }
    if (!accept(path.extname(normalized).slice(1).toLowerCase())) throw badRequest('不支持的文件类型')
    const target = path.resolve(base, normalized)
    if (target !== base && !target.startsWith(base + path.sep)) throw badRequest('文档路径无效')
    const stat = fs.statSync(target, { throwIfNoEntry: false })
    if (!stat?.isFile()) throw Object.assign(new Error('文档不存在'), { status: 404 })
    return { path: target, name: path.basename(target), size: stat.size }
  }

  return { list, snapshot, changedSince, resolve, resolveAsset }
}
