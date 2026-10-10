import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { wirelessDataDir } from './workflow.js'
import { matches, vendorName, systemName } from './catalog.js'

const plugin = fileURLToPath(new URL('../', import.meta.url))
const worker = path.join(plugin, 'worker/compile.py')
const sourceManifest = JSON.parse(fs.readFileSync(path.join(plugin, 'vendor/echo_mem/source-manifest.json'), 'utf8'))
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
// State pools follow pinned pipeline/shadow/retrieve.py; demos never enter decision pools.
function memoryPool({ memory, compiler }) {
  const strategy = ['strategy_memory', 'playbook_memory'].includes(memory.memory_type)
  if (compiler.mode === 'demo' || memory.state === 'deprecated') return 'background'
  if (memory.memory_type === 'counter_evidence_memory' || (strategy && memory.state === 'counter_evidence')) return 'counter_evidence'
  if (strategy && memory.state === 'restricted') return 'review_evidence'
  if (strategy && ['validated', 'reusable'].includes(memory.state)) return 'positive_candidates'
  return 'background'
}
const packageIdOf = value => {
  if (!/^wp_[a-f0-9]{24}$/.test(value || '')) throw new Error('package_id 必须使用编译工具返回的 ID')
  return value
}
function verifyPackage(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  for (const [name, hash] of Object.entries(manifest.checksum.values)) {
    if (path.basename(name) !== name || digest(fs.readFileSync(path.join(directory, name))) !== hash) throw new Error('记忆包文件校验失败')
  }
  return manifest
}

async function callWorker(python, args, signal) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', finished = false
    const child = spawn(python, ['-B', worker, ...args], { signal, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
    const fail = error => { if (!finished) { finished = true; reject(error) } }
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(new Error('知识编译超过 60 秒；请减小批次')) }, 60000)
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 1000000) { child.kill('SIGKILL'); fail(new Error('编译输出超过限制')) } })
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-12000) })
    child.on('error', error => { clearTimeout(timer); fail(error) })
    child.on('close', code => {
      clearTimeout(timer)
      if (finished) return
      finished = true
      if (code !== 0) { reject(new Error(stderr.trim() || `compiler exit ${code}`)); return }
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error('编译器未返回合法 JSON')) }
    })
  })
}

export function createMemoryService({ directory = wirelessDataDir(), workspace = process.cwd(), python } = {}) {
  const packages = path.join(directory, 'packages')
  const managedPython = path.resolve(plugin, '../../.runtime/wireless-python/bin/python')
  const executable = python || process.env.WIRELESS_PYTHON || (fs.existsSync(managedPython) ? managedPython : 'python3')
  return {
    search({ query, vendor, system, package_ids, as_of = new Date().toISOString(), include_demo = false, limit = 6 } = {}) {
      if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw new Error('query 必须为 1 至 2000 字符')
      if (!Number.isInteger(limit) || limit < 1 || limit > 12) throw new Error('limit 必须是 1 至 12 的整数')
      if (typeof as_of !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(as_of) || !Number.isFinite(Date.parse(as_of))) throw new Error('as_of 必须是带时区的 ISO 时间')
      if (package_ids !== undefined && (!Array.isArray(package_ids) || !package_ids.length || package_ids.length > 100)) throw new Error('package_ids 必须为 1 至 100 个包 ID')
      const ids = package_ids ? [...new Set(package_ids.map(packageIdOf))]
        : (fs.existsSync(packages) ? fs.readdirSync(packages).filter(id => /^wp_[a-f0-9]{24}$/.test(id)) : []).sort()
      const sources = [], found = []
      for (const package_id of ids) {
        const root = path.join(packages, package_id)
        try {
          const manifest = verifyPackage(root)
          const compiler = manifest.harness
          if (!['historical', 'demo'].includes(compiler?.mode) || !Number.isFinite(Date.parse(compiler.as_of))) throw new Error('记忆包缺少模式或截止时间')
          const source = { package_id, mode: compiler.mode, as_of: compiler.as_of, source: manifest.source }
          if (as_of && Date.parse(compiler.as_of) > Date.parse(as_of)) {
            sources.push({ ...source, status: 'after_decision_cutoff' }); continue
          }
          if (compiler.mode === 'demo' && !include_demo) {
            sources.push({ ...source, status: 'demo_excluded' }); continue
          }
          const rows = name => fs.readFileSync(path.join(root, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
          const scores = new Map(rows('memory_scores.jsonl').map(row => [row.memory_id, row]))
          const profiles = new Map(rows('memory_evidence_profiles.jsonl').map(row => [row.memory_id, row]))
          const memories = rows('memory_objects.jsonl')
          const matched = []
          for (const memory of memories) {
            const app = memory.applicability || {}, context_comparison = {}
            let incompatible = false
            for (const [key, expected, values, canonicalize] of [
              ['vendor', vendor, app.vendors, vendorName], ['system', system, app.systems, systemName],
            ]) {
              if (!expected) continue
              const known = (values || []).filter(value => value && !/未知|未标注/.test(value))
              const status = !known.length ? 'unknown_requires_confirmation'
                : known.some(value => canonicalize(value) === canonicalize(expected)) ? 'matches' : 'incompatible'
              context_comparison[key] = { requested: expected, historical: known, status }
              if (status === 'incompatible') incompatible = true
            }
            if (incompatible) continue
            const match = matches(query, [memory.title, memory.summary,
              ...(app.issue_types || []), ...(app.root_causes || []), ...(app.scheme_groups || []),
              JSON.stringify(memory.content || {})])
            if (!match.relevance_score) continue
            matched.push({ package_id, compiler, source: manifest.source, memory,
              score: scores.get(memory.memory_id) || null, evidence_profile: profiles.get(memory.memory_id) || null,
              ...match, context_comparison,
              usage: { automatic_accept_certificate: false, current_root_cause_confirmed: false,
                effect_statistics_authority: compiler.mode === 'demo' ? 'demonstration_only' : 'bounded_by_evidence_profile' } })
          }
          found.push(...matched)
          sources.push({ ...source, status: 'searched', memory_count: memories.length, total_matches: matched.length })
        } catch (error) {
          sources.push({ package_id, status: 'read_error', error: error.message })
        }
      }
      found.sort((a, b) => b.relevance_score - a.relevance_score || a.package_id.localeCompare(b.package_id) || a.memory.memory_id.localeCompare(b.memory.memory_id))
      // Keep all six memory types visible; a long positive pool must not hide counter-evidence.
      const types = ['case_memory', 'rca_memory', 'strategy_memory', 'playbook_memory', 'risk_memory', 'counter_evidence_memory']
      const by_type = Object.fromEntries(types.map(type => {
        const rows = found.filter(row => row.memory.memory_type === type)
        return [type, { memories: rows.slice(0, limit), total_matches: rows.length, truncated: rows.length > limit }]
      }))
      const memories = Object.values(by_type).flatMap(group => group.memories)
      // Bound each decision pool independently, before type pagination can hide warnings.
      const poolNames = ['positive_candidates', 'review_evidence', 'counter_evidence', 'background']
      const poolRows = Object.fromEntries(poolNames.map(name => [name, found.filter(row => memoryPool(row) === name)]))
      const candidate_pools = Object.fromEntries(poolNames.map(name => [name, poolRows[name].slice(0, limit)]))
      const candidate_pool_counts = Object.fromEntries(poolNames.map(name => [name,
        { total_matches: poolRows[name].length, truncated: poolRows[name].length > limit }]))
      const historical = sources.filter(row => row.mode === 'historical' && row.status === 'searched')
      return { sources, by_type, memories, candidate_pools, candidate_pool_counts, total_matches: found.length,
        historical_package_count: historical.length,
        unique_matched_trace_ids: [...new Set(found.filter(row => row.compiler.mode === 'historical').flatMap(row => row.memory.trace_ids || []))],
        truncated: [...Object.values(by_type), ...Object.values(candidate_pool_counts)].some(group => group.truncated),
        interpretation: '自动发现并校验本地冻结包；命中数是记忆版本条目数，不是独立工单数或成功率。跨包重复 Trace 不累加统计，分数和作用域保留在各自版本；这不是完整研究排序或校准门控。' }
    },
    async compile({ file_path, as_of, mode = 'historical', evaluation_visible_at_cutoff = false } = {}, execution = {}) {
      const missing = []
      if (!file_path) missing.push('file_path: 源 TraceRecord JSONL 或 JSON 数组')
      if (!as_of) missing.push('as_of: 带时区的版本截止时间')
      if (mode === 'historical' && !evaluation_visible_at_cutoff) missing.push('evaluation_visible_at_cutoff: 截止前结果可见声明')
      if (missing.length) return { status: 'needs_data', missing_fields: missing }
      if (!['historical', 'demo'].includes(mode)) throw new Error('未知编译 mode')
      if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(as_of) || !Number.isFinite(Date.parse(as_of))) throw new Error('as_of 必须是带时区的 ISO 时间')
      const root = fs.realpathSync(workspace), input = fs.realpathSync(path.resolve(workspace, file_path))
      if (!input.startsWith(root + path.sep)) throw new Error('历史输入必须位于当前工作区，不能通过符号链接读取外部文件')
      if (!fs.statSync(input).isFile() || fs.statSync(input).size > 4 * 1024 * 1024) throw new Error('历史输入必须是最多 4 MB 的文件；单批最多 200 条 Trace')
      const raw = fs.readFileSync(input)
      const id = `wp_${digest(JSON.stringify({ input: digest(raw), as_of, mode, evaluation_visible_at_cutoff,
        source: digest(JSON.stringify(sourceManifest)), adapter: digest(fs.readFileSync(worker)) })).slice(0, 24)}`
      const target = path.join(packages, id)
      if (fs.existsSync(target)) return { status: 'compiled_local_package', package_id: id, reused: true,
        package_path: target, manifest: verifyPackage(target) }
      fs.mkdirSync(packages, { recursive: true })
      const temporary = fs.mkdtempSync(path.join(packages, 'pending-'))
      try {
        const frozenInput = path.join(temporary, 'submitted-traces.jsonl')
        fs.writeFileSync(frozenInput, raw)
        const output = path.join(temporary, 'package')
        const result = await callWorker(executable, ['--input', frozenInput, '--output', output, '--as-of', as_of,
          '--mode', mode, ...(evaluation_visible_at_cutoff ? ['--evaluation-visible'] : [])], execution.signal)
        if (result.status === 'needs_data') return result
        const manifest = verifyPackage(output)
        manifest.package_id = id
        fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
        // Another request may have compiled the same immutable content while this worker ran.
        if (!fs.existsSync(target)) fs.renameSync(output, target)
        else verifyPackage(target)
        return { ...result, package_id: id, package_path: target, manifest: verifyPackage(target),
          interpretation: '本地冻结记忆包，由源 ECHO-Mem 规则编译；演示包不可计入真实效果统计。未发布远程知识，未加载校准 gate；编译状态不等于现网自动下发许可。' }
      } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
    },
    query({ package_id, query = '', memory_type, limit = 6 } = {}) {
      packageIdOf(package_id)
      if (!Number.isInteger(limit) || limit < 1 || limit > 12) throw new Error('limit 必须是 1 至 12 的整数')
      const root = path.join(packages, package_id), manifest = verifyPackage(root)
      const rows = name => fs.readFileSync(path.join(root, name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      const scores = new Map(rows('memory_scores.jsonl').map(row => [row.memory_id, row]))
      const profiles = new Map(rows('memory_evidence_profiles.jsonl').map(row => [row.memory_id, row]))
      const text = String(query).toLowerCase().trim()
      const memories = rows('memory_objects.jsonl').filter(row => (!memory_type || row.memory_type === memory_type) &&
        (!text || JSON.stringify(row).toLowerCase().includes(text)))
      return { package_id, source: manifest.source, compiler: manifest.harness,
        memories: memories.slice(0, limit).map(row => ({ memory: row, score: scores.get(row.memory_id) || null,
          evidence_profile: profiles.get(row.memory_id) || null,
          usage: { automatic_accept_certificate: false,
            effect_statistics_authority: manifest.harness.mode === 'demo' ? 'demonstration_only' : 'bounded_by_evidence_profile',
            current_root_cause_confirmed: false } })), total_matches: memories.length, truncated: memories.length > limit,
        interpretation: '按包 ID 读取固定版本；保留来源 Trace ID、状态、支持/反证、评分及作用域。unverified 或 demo 不转成现场可复用结论；RCA 的 validated 可来自结构证据，不代表根因正确率或当前根因确证。没有校准 gate 就不生成自动放行证书。' }
    },
  }
}
