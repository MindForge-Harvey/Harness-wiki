/**
 * dsh-knowledge v2 · EnginePort —— LightRAG 适配层（唯一知道引擎怪癖的地方）。
 *
 * 仓库内其余模块只面向本文件导出的接口编程；引擎的实测怪癖
 * （DESIGN §11.1 引擎契约）全部封装在这里：
 *
 *  1. 同 source 重插返回 409（Document storage already contains…）
 *     → replace 场景必须"临时 source 先插新、成功后删旧"。
 *  2. 删除是异步的，且管道忙时发出的删除请求可能被静默丢弃（200 但不执行）。
 *     → 删除必须走意图账本 + 收敛核验（lib/intent.js），本层不负责重试。
 *  3. track_status 直接返回 doc_id 与状态，无需扫描列表定位。
 *  4. 管道忙时（部分）写操作返回 409 Pipeline is busy。
 *     → isPipelineBusy(e) 判定，调用方决定排队或稍后重试。
 *  5. GraphML 存储不支持 list 类型属性值（写图 500）。
 *     → flattenGraphArrays 在本层出口统一拍平，别处不再关心。
 *  6. page_size 下限 10；/graphs 必填 label；GET /documents 不支持按 id 过滤。
 *  7. 文档 id 内容寻址：相同内容得到相同 doc_id（删除后可原样重建）。
 *
 * 假引擎（dev 用 fake-engine.js）实现同一接口并模拟上述怪癖，
 * 契约测试据此在无真实引擎环境下锁定本层行为。
 */

import path from 'node:path'

export const QUERY_MODES = ['mix', 'local', 'global', 'hybrid', 'naive', 'bypass']

const DEFAULT_BASE_URL = 'http://127.0.0.1:9623'

/** 引擎错误是否为"管道忙"（用于上层排队重试与友好提示）。 */
export function isPipelineBusy(e) {
  return !!(e && e.status === 409 && /busy|another operation|clearing|deleting|running job/i.test(String(e.message)))
}

/** GraphML 不支持数组属性值：写图谱前把任意深度的数组拍平为顿号串。 */
export function flattenGraphArrays(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).join('，')
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = flattenGraphArrays(v)
    return out
  }
  return value
}

/** 创建 LightRAG HTTP 适配器（v1.5.6 契约）。 */
export function createLightRagEngine(baseUrl) {
  const base = String(baseUrl || process.env.LIGHTRAG_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const apiKey = process.env.LIGHTRAG_API_KEY || ''
  const authHeaders = apiKey ? { 'X-API-Key': apiKey } : {}

  async function request(pathname, opts = {}) {
    const { method = 'GET', jsonBody, formBody, signal, timeoutMs = 120000 } = opts
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    let body
    const headers = { ...authHeaders }
    if (formBody !== undefined) body = formBody
    else if (jsonBody !== undefined) {
      body = JSON.stringify(jsonBody)
      headers['content-type'] = 'application/json'
    }
    try {
      const resp = await fetch(base + pathname, { method, headers, body, signal: controller.signal })
      const text = await resp.text()
      let data = null
      try { data = text ? JSON.parse(text) : null } catch (e) { /* 非 JSON 响应体 */ }
      if (!resp.ok) {
        let detail = text
        if (data && data.detail !== undefined) {
          detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)
        }
        const err = new Error('LightRAG ' + resp.status + ': ' + String(detail || resp.statusText).slice(0, 500))
        err.status = resp.status
        throw err
      }
      return data
    } catch (e) {
      if (controller.signal.aborted && !(signal && signal.aborted)) {
        const terr = new Error('LightRAG timeout after ' + timeoutMs + 'ms')
        terr.status = 0
        throw terr
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  async function streamQuery(payload, onLine, signal, timeoutMs = 300000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    try {
      const resp = await fetch(base + '/query/stream', {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => '')
        const err = new Error('LightRAG stream ' + resp.status + ': ' + String(text).slice(0, 300))
        err.status = resp.status
        throw err
      }
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (!line) continue
          let obj = null
          try { obj = JSON.parse(line) } catch (e) { continue }
          if (onLine) onLine(obj)
        }
      }
    } catch (e) {
      if (controller.signal.aborted && !(signal && signal.aborted)) {
        const terr = new Error('LightRAG stream timeout')
        terr.status = 0
        throw terr
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    kind: 'lightrag',
    baseUrl: base,

    // ---- 健康与管道 ----
    health: (signal) => request('/health', { signal, timeoutMs: 60000 }),
    pipelineStatus: (signal) => request('/documents/pipeline_status', { signal, timeoutMs: 30000 }),

    // ---- 检索（查询路径刻意薄：无门控、无重计算） ----
    query(payload, signal) {
      const p = { mode: 'mix', only_need_context: false, enable_rerank: false, ...payload }
      return request('/query', { method: 'POST', jsonBody: p, signal, timeoutMs: 120000 })
    },
    queryStream(payload, onLine, signal) {
      const p = { mode: 'mix', only_need_context: false, enable_rerank: false, stream: true, ...payload }
      return streamQuery(p, onLine, signal)
    },
    queryData(payload, signal) {
      // only_need_context: true —— 只要检索数据，不让 LightRAG 内部调 LLM 生成答案；答案由 dsh 模型基于证据组织
      const p = { mode: 'mix', enable_rerank: false, only_need_context: true, ...payload }
      return request('/query/data', { method: 'POST', jsonBody: p, signal, timeoutMs: 120000 })
    },

    // ---- 文档 ----
    listDocuments(opts = {}, signal) {
      const body = { page: 1, page_size: 20, sort_field: 'updated_at', sort_direction: 'desc', ...opts }
      return request('/documents/paginated', { method: 'POST', jsonBody: body, signal, timeoutMs: 60000 })
    },
    statusCounts: (signal) => request('/documents/status_counts', { signal, timeoutMs: 30000 }),
    supportedFileTypes: (signal) => request('/documents/supported_file_types', { signal, timeoutMs: 30000 }),
    uploadFile(filename, bytes, signal) {
      const form = new FormData()
      form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), filename)
      return request('/documents/upload', { method: 'POST', formBody: form, signal, timeoutMs: 120000 })
    },
    insertText(text, fileSource, signal) {
      const body = { text }
      if (fileSource !== undefined) body.file_source = fileSource
      return request('/documents/text', { method: 'POST', jsonBody: body, signal, timeoutMs: 120000 })
    },
    /** 删除请求：引擎异步执行、忙时可能静默丢弃（200 但不执行）——调用方必须核验。 */
    deleteDocuments(docIds, opts = {}, signal) {
      return request('/documents/delete_document', {
        method: 'DELETE',
        jsonBody: { doc_ids: docIds, delete_file: false, delete_llm_cache: true, ...opts },
        signal,
        timeoutMs: 60000,
      })
    },
    reprocessFailed: (docIds, signal) => request('/documents/reprocess_failed', {
      method: 'POST',
      jsonBody: docIds && docIds.length ? { doc_ids: docIds } : {},
      signal,
      timeoutMs: 60000,
    }),
    trackStatus: (trackId, signal) => request('/documents/track_status/' + encodeURIComponent(trackId), { signal, timeoutMs: 30000 }),

    // ---- 治理（curator） ----
    sourceConflicts(opts = {}, signal) {
      const qs = new URLSearchParams()
      if (opts.limit !== undefined) qs.set('limit', String(opts.limit))
      if (opts.cursor) qs.set('cursor', String(opts.cursor))
      const suffix = qs.toString() ? '?' + qs.toString() : ''
      return request('/documents/source_conflicts' + suffix, { signal, timeoutMs: 60000 })
    },

    // ---- 图谱（出口统一拍平数组值；管道忙 409 原样抛出供上层分诊） ----
    entityExists(name, signal) {
      return request('/graph/entity/exists?name=' + encodeURIComponent(name), { signal, timeoutMs: 30000 })
    },
    entityCreate(entityName, entityData, signal) {
      return request('/graph/entity/create', {
        method: 'POST',
        jsonBody: { entity_name: entityName, entity_data: flattenGraphArrays(entityData || {}) },
        signal, timeoutMs: 60000,
      })
    },
    entityEdit(entityName, updatedData, opts = {}, signal) {
      return request('/graph/entity/edit', {
        method: 'POST',
        jsonBody: {
          entity_name: entityName,
          updated_data: flattenGraphArrays(updatedData || {}),
          allow_rename: false, allow_merge: false, ...opts,
        },
        signal, timeoutMs: 60000,
      })
    },
    entityDelete(entityName, signal) {
      return request('/graph/entity/delete', { method: 'DELETE', jsonBody: { entity_name: entityName }, signal, timeoutMs: 60000 })
    },
    entityMerge(entitiesToChange, entityToChangeInto, signal) {
      return request('/graph/entities/merge', {
        method: 'POST',
        jsonBody: { entities_to_change: entitiesToChange, entity_to_change_into: entityToChangeInto },
        signal, timeoutMs: 60000,
      })
    },
    relationCreate(sourceEntity, targetEntity, relationData, signal) {
      return request('/graph/relation/create', {
        method: 'POST',
        jsonBody: { source_entity: sourceEntity, target_entity: targetEntity, relation_data: flattenGraphArrays(relationData || {}) },
        signal, timeoutMs: 60000,
      })
    },
    relationEdit(sourceId, targetId, updatedData, signal) {
      return request('/graph/relation/edit', {
        method: 'POST',
        jsonBody: { source_id: sourceId, target_id: targetId, updated_data: flattenGraphArrays(updatedData || {}) },
        signal, timeoutMs: 60000,
      })
    },
    relationDelete(sourceEntity, targetEntity, signal) {
      return request('/graph/relation/delete', {
        method: 'DELETE',
        jsonBody: { source_entity: sourceEntity, target_entity: targetEntity },
        signal, timeoutMs: 60000,
      })
    },
    labelSearch(q, limit = 20, signal) {
      return request('/graph/label/search?q=' + encodeURIComponent(q || '') + '&limit=' + limit, { signal, timeoutMs: 30000 })
    },
    labelList: (signal) => request('/graph/label/list', { signal, timeoutMs: 30000 }),
    async graphs(opts = {}, signal) {
      const { max_depth = 2, max_nodes = 200 } = opts
      let label = opts.label
      if (!label) {
        // /graphs 必填 label；缺省回退第一个已知 label
        try {
          const labels = await this.labelList(signal)
          const list = Array.isArray(labels) ? labels : []
          label = list[0] || null
          if (!label) return { labels: [], entities: [], relations: [] }
        } catch (e) {
          return { labels: [], entities: [], relations: [], error: String(e && e.message ? e.message : e) }
        }
      }
      const qs = '?max_depth=' + max_depth + '&max_nodes=' + max_nodes + '&label=' + encodeURIComponent(label)
      return request('/graphs' + qs, { signal, timeoutMs: 60000 })
    },
  }
}

/** 引擎状态 → 注册表状态（收养/对账用）。 */
export function engineStatusToRegistry(engineStatus) {
  switch (engineStatus) {
    case 'processed': return 'active'
    case 'preprocessed': return 'active'
    case 'failed': return 'failed'
    case 'parsing':
    case 'analyzing':
    case 'processing': return 'processing'
    case 'pending': return 'pending'
    default: return engineStatus || 'pending'
  }
}

/**
 * 检索快照限额（诊断用；超出部分按引擎返回顺序截断）。
 * 快照服务于根因分析而非全文回放，只保留可定位、可比对的字段。
 */
export const RETRIEVAL_SNAPSHOT_LIMITS = Object.freeze({
  chunks: 5,
  chunkChars: 3000,
  entities: 20,
  relations: 30,
  descChars: 500,
})

/**
 * 把 /query/data 响应裁剪成诊断快照：只保留实体名/描述、关系两端/描述、
 * chunk 内容（截断）与引用文件。诊断需要"当时检索到了什么"，不需要完整图数据。
 * @param {*} data - /query/data 响应的 data 对象（entities/relationships/chunks/references）。
 * @returns {{entities: Array, relationships: Array, chunks: Array, references: Array, truncated: boolean}}
 */
export function clipQueryData(data) {
  const L = RETRIEVAL_SNAPSHOT_LIMITS
  const src = data && typeof data === 'object' ? data : {}
  const cut = (s, n) => String(s ?? '').slice(0, n)
  const entities = (Array.isArray(src.entities) ? src.entities : []).slice(0, L.entities)
    .map((e) => e && typeof e === 'object' ? {
      entity_id: e.entity_id ?? null,
      entity_name: e.entity_name ?? '',
      description: cut(e.description, L.descChars),
      source_id: e.source_id ?? null,
      file_path: e.file_path ?? null,
    } : null).filter(Boolean)
  const relationships = (Array.isArray(src.relationships) ? src.relationships : []).slice(0, L.relations)
    .map((r) => r && typeof r === 'object' ? {
      src_id: r.src_id ?? null,
      tgt_id: r.tgt_id ?? null,
      description: cut(r.description, L.descChars),
      weight: typeof r.weight === 'number' ? r.weight : null,
    } : null).filter(Boolean)
  const chunks = (Array.isArray(src.chunks) ? src.chunks : []).slice(0, L.chunks)
    .map((c) => c && typeof c === 'object' ? {
      reference_id: c.reference_id ?? null,
      // 引擎的完整 chunk 键（doc-<hash>-chunk-NNN / -mm-drawing-NNN）：
      // reference_id 只是本页序号，mm 反查（图文关联）依赖 chunk_id
      chunk_id: c.chunk_id ?? null,
      file_path: c.file_path ?? null,
      content: cut(c.content, L.chunkChars),
    } : null).filter(Boolean)
  const references = (Array.isArray(src.references) ? src.references : []).slice(0, L.chunks)
    .map((r) => r && typeof r === 'object' ? {
      file_path: r.file_path ?? null,
      reference_id: r.reference_id ?? null,
      score: typeof r.score === 'number' ? r.score : null,
    } : null).filter(Boolean)
  const truncated = (Array.isArray(src.chunks) && src.chunks.length > L.chunks)
    || (Array.isArray(src.entities) && src.entities.length > L.entities)
    || (Array.isArray(src.relationships) && src.relationships.length > L.relations)
  return { entities, relationships, chunks, references, truncated }
}

/** 从 /query/data 响应提取去重文件名集合（缺口分诊与检索证据核对共用）。 */
export function fileSetOf(data) {
  const set = new Set()
  for (const list of [data.references, data.chunks, data.entities]) {
    if (!Array.isArray(list)) continue
    for (const r of list) {
      const fp = r && r.file_path
      if (typeof fp === 'string' && fp) set.add(path.basename(fp))
    }
  }
  return set
}
