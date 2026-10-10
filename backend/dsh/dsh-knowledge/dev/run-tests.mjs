/**
 * dsh-knowledge v2 · 本地测试入口（零网络、零真实引擎）。
 *
 * 运行全部：node dev/run-tests.mjs
 * 运行单个：node dev/contract-intent.mjs
 *
 * 真实引擎的现网验证不在此列（需要 LightRAG 服务与 KB_* 环境变量）。
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const SUITES = [
  'contract-store.mjs',    // 存储原语（原子写/防抖/append-only/压缩）
  'contract-engine.mjs',   // 假引擎锁定引擎契约怪癖 + engine-port 纯函数
  'contract-http-engine.mjs', // 真实 HTTP 出口：API Key / multipart / stream / 远程前缀
  'contract-intent.mjs',   // 意图账本（WAL/状态机/崩溃恢复/替换阶段机）
  'contract-reconciler.mjs', // 收敛器（收养/缺失/补删/豁免/分页）
  'contract-service.mjs',  // 单一写入口（origin 策略/幂等/审计）
  'contract-curator.mjs',  // 检索日志数据层（追加/读取/快照归并）
  'contract-images.mjs',   // 图文关联（解析/注入/mm反查/EMF转换）
  'analyze-unit.mjs',      // 健康分析（缺口三分类/聚类/周报）
  'contract-feedback.mjs', // 反馈账本与诊断提案（限制/持久化）
  'contract-ops.mjs',      // 运营指标口径（重复率/聚类/批准/判定/重出/层级）
  'contract-graph-tools.mjs', // 模型工具图谱链路（kb_graph_search/kb_update 审批）
  'render-smoke.mjs',      // 前端组件树冒烟（全部 tab/子页 + 图标 + 槽位）
]

let failedSuites = 0
for (const suite of SUITES) {
  const r = spawnSync(process.execPath, [path.join(here, suite)], { stdio: 'inherit' })
  if (r.status !== 0) failedSuites++
}
console.log('')
if (failedSuites) {
  console.log(failedSuites + ' suite(s) FAILED')
  process.exit(1)
}
console.log('all ' + SUITES.length + ' suites passed')
