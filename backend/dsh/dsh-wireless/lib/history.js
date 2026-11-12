import { catalogStatus, caseSearch, knowledgeQuery } from './catalog.js'
import { createMemoryService } from './compiler.js'
import { createOrderArchive } from './orders.js'

// Analysis reads historical evidence. Compilation and workorder mutations remain separate tools.
export function createHistorySearch({ memory = createMemoryService(), orders = createOrderArchive() } = {}) {
  return function historySearch(args = {}) {
    const { query, vendor, system, limit = 6, as_of = new Date().toISOString() } = args
    const compiled = memory.search({ ...args, as_of })
    const snapshot = catalogStatus().snapshot
    const snapshotAfterCutoff = as_of && Date.parse(snapshot.date) > Date.parse(as_of)
    const knowledge = snapshotAfterCutoff ? null : knowledgeQuery({ query, vendor, system, limit })
    const cases = snapshotAfterCutoff ? { cases: [], total_matches: 0, truncated: false }
      : caseSearch({ query, vendor, system, limit })
    const incomplete = compiled.sources.some(row => row.status === 'read_error')
    const matched = cases.total_matches > 0 || compiled.total_matches > 0
    const archive = orders({ operation: 'catalog' })
    return {
      status: incomplete ? 'search_incomplete' : matched ? 'history_match' : 'no_history_match',
      query, filters: { vendor: vendor || null, system: system || null, as_of: as_of || null },
      sources: {
        snapshot: { ...snapshot, status: snapshotAfterCutoff ? 'after_decision_cutoff' : 'searched',
          available_case_entries: catalogStatus().counts.case_entries,
          temporal_authority: 'snapshot_version_only; per_case_evaluation_visibility_not_verified' },
        local_memory_packages: { status: incomplete ? 'read_error' : compiled.historical_package_count ? 'available' : 'no_eligible_historical_package',
          historical_package_count: compiled.historical_package_count, packages: compiled.sources },
        workorder_archive: { status: archive.available ? 'available' : archive.status,
          ...(archive.available ? { total_tickets: archive.total_tickets, date_range: archive.date_range } : {}),
          query_tool: 'wireless_order_query', purpose: '业务工单详情与列表，独立于经验检索范围' },
      },
      cases: cases.cases, total_case_matches: cases.total_matches, cases_truncated: cases.truncated,
      memories: compiled.by_type, candidate_pools: compiled.candidate_pools, candidate_pool_counts: compiled.candidate_pool_counts,
      unique_matched_trace_ids: compiled.unique_matched_trace_ids,
      parameter_semantics: knowledge?.results.parameters || [],
      relevant_lessons: knowledge?.results.lessons || [],
      method_lessons: snapshotAfterCutoff ? [] : knowledgeQuery({ query: '经验', kind: 'lessons', limit: 12 }).results.lessons,
      semantic_references: knowledge?.references || [],
      method: { source_commit: snapshot.commit,
        candidate_pool_source: 'echo-mem-reproducibility/pipeline/shadow/retrieve.py',
        retrieval_mode: 'explainable_field_match', calibrated_gate_loaded: false,
        research_ranker_available: true, research_value_selector_available: true,
        full_research_pipeline_connected: false },
      interpretation: [
        '这是历史经验检索。工单库列表、月份统计及业务单号详情用 wireless_order_query；经验未命中不表示工单不存在。',
        '未命中只限当前检索范围，不证明知识全局不存在或参数虚构；这是正常交付，不触发知识库诊断、反馈、图谱修改或假工单。',
        '参数语义和研究经验保留作分析依据，但不算已命中的实测工单；合成样本不进入正向候选或真实效果统计。',
        '语义条目或方案名称不证明历史执行过、常用或有效，条目数量不能用作根因概率；当前观测缺口径/对象/窗口时先保留可比性缺口。',
        '正向、复核、反证分池沿用源状态规则；命中和 validated 都不代表当前根因已确认或可自动下发。',
        '逐版本保留源 Trace、证据画像与评分，跨包重复工单不累加支持数。',
        '回答保留简短工单/案例标识、历史动作和已知结果，解释与当前条件的异同；链接按需提供。',
      ],
    }
  }
}
