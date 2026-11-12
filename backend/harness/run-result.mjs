import { plainAssistantText } from './narrative.mjs'

/** SDK idle can mean an aborted turn, rather than a successfully delivered answer. */
export function completedRunText(result) {
  const reason = result.events?.findLast(event => event.type === 'turn/end')?.data?.reason
  if (reason?.kind === 'aborted') throw Object.assign(new Error(reason.reason?.kind === 'disposed'
    ? '运行配置更新中断了本轮分析，已有记录已保留。发送“继续”可恢复分析。'
    : '本轮分析已中断，已有记录已保留。发送“继续”可恢复分析。'), { code: 'HARNESS_RUN_INTERRUPTED' })
  if (reason?.kind === 'error') throw new Error(reason.error?.message || '本轮分析未能完成')
  const answer = plainAssistantText(result.finalResponse || '')
  if (!answer.trim()) throw Object.assign(new Error('本轮尚未生成完整回答，已有工具结果已保留。发送“继续”可接着分析。'),
    { code: 'HARNESS_EMPTY_RESPONSE' })
  return answer
}
