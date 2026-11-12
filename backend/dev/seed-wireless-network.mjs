/** Install the user's requested 2026-11-01 observation snapshots without rewriting archive tickets. */
import fs from 'node:fs'
import { createOrderArchive } from '../dsh/dsh-wireless/lib/orders.js'
import { createNetworkDataStore } from '../dsh/dsh-wireless/lib/network-data.js'
import { archiveRules } from '../dsh/dsh-wireless/lib/order-context.js'

const date = '2026-11-01'
const definitions = JSON.parse(fs.readFileSync(new URL('../dsh/dsh-wireless/resources/network/metric-dictionary.json', import.meta.url)))
const archive = createOrderArchive(), store = createNetworkDataStore({ writable: true })
const round = value => Math.round(value * 10000) / 10000
const windowAt = index => ({ start: `${date}T${String(Math.floor(index / 4)).padStart(2, '0')}:${String(index % 4 * 15).padStart(2, '0')}:00+08:00`,
  end: index === 95 ? '2026-11-02T00:00:00+08:00' : `${date}T${String(Math.floor((index + 1) / 4)).padStart(2, '0')}:${String((index + 1) % 4 * 15).padStart(2, '0')}:00+08:00` })
function observation(system, column, value, object_id, index, source_ref, counters) {
  const metric = definitions.find(row => row.system === system && row.column === column)
  const threshold = column === 'his016' && system === '5G' ? 85 : column === 'his013' && system === '5G' ? 1 : null
  return { object_id, kind: metric.name.includes('MR') || metric.name.includes('SINR') ? 'mr' : 'kpi', metric: metric.name, source_column: column, value: round(value), unit: metric.unit,
    definition: metric.formula, raw_value: metric.unit === '%' ? round(value / 100) : value,
    time_window: windowAt(index), source_ref, data_origin:'constructed', ...(counters ? { counters } : {}),
    ...(threshold ? { threshold: { operator: 'gt', value: threshold, source_ref: source_ref + '/analysis-policy' } } : {}),
    ...(!metric.name.includes('连接') ? { good_direction: metric.name.includes('成功率') || metric.name.includes('覆盖率') ? 'higher' : 'lower' } : {}) }
}
function nr(record) {
  const source_ref = `network://20261101/${record.ticket.id}`
  const object_id = record.ticket.cell_id, observations = []
  for (let index = 0; index < 96; index++) {
    const hour = Math.floor(index / 4), busy = hour >= 18 && hour <= 21, peak = hour - 18
    const jitter = [0, .1, -.1, 0][index % 4]
    const drop = busy ? [1.8, 2.6, 2.3, 2][peak] : round(.25 + (hour % 4) * .05)
    const uplink = busy ? [89, 94, 92, 90][peak] : 30 + hour % 7 * 2
    const values = { his013: drop, his016: uplink + jitter, his017: busy ? [52,61,58,55][peak] : 35 + hour % 7,
      his034: busy ? [322,364,350,336][peak] : 96 + hour % 6 * 10,
      his035: busy ? [460,520,500,480][peak] : 150 + hour % 6 * 12,
      his036: busy ? [38,46,43,40][peak] : 24 + hour % 5,
      his054: 98.2, his010: 99.3, his006: -113 + jitter,
      his081: 1.1, his019: 99.65, his020: 99.6 }
    const counters = { CONTEXT_AttRelgNB: 2000 + Math.round(drop * 100), CONTEXT_AttRelgNB_Normal: 2000,
      CONTEXT_SuccInitalSetup: 8000, CONTEXT_NbrLeft: 1200, HO_SuccExecInc: 600,
      RRC_SuccConnReestab_NonSrccell: 100, 'RRC.SuccConnResume.NonSrccell': 50, IRATHO_SuccExecInc: 50 }
    for (const [column, value] of Object.entries(values)) observations.push(observation('5G', column, value, object_id, index, source_ref,
      column === 'his013' ? counters : column === 'his016' ? { RRU_PuschPrbAssn: Math.round(value * 10000), RRU_PuschPrbTot: 1000000 }
        : column === 'his017' ? { RRU_PdschPrbAssn: Math.round(value * 10000), RRU_PdschPrbTot: 1000000 } : undefined))
    for (const [column,value] of Object.entries({his016: 17 + hour % 5 * 2,his017: 18 + hour % 5 * 2,his035: 80 + hour % 5 * 10})) {
      observations.push(observation('5G', column, value, 'XA-JD-N78-01', index, source_ref + '/neighbor'))
    }
  }
  const conclusion = '主要原因：容量-上行利用率超限，18:00—21:00上行PRB利用率89%—94%，掉线率1.8%—2.6%，正常时段上行PRB为30%—42%、掉线率0.25%—0.40%；资源不足异常释放占忙时异常释放的82%。次要原因：负载均衡方向配置仅DOWNLINK，未覆盖上行负荷分担；已有同覆盖低负荷异频邻区可承载，方位角差12度，近7日上下行PRB最大26%/28%、RRC连接最大数128。'
  return { ticket_id: record.ticket.id, snapshot_date: date, source_ref,
    provenance: { origin: 'constructed', authorization: 'user_requested_20261101_supplement', archive_source: record.source_ref },
    order_patch: { conclusion, smart_conclusion: '忙时上行资源拥塞与异常释放同步升高；覆盖、干扰、邻区与设备告警无异常。建议核对原初案负载均衡方向DOWNLINK→DUAL，利用现有低负荷异频邻区分担上行用户。',
      resource_totalverdict: conclusion,
      cover_totalverdict: 'MR覆盖率98.2%，弱覆盖采样占比1.8%，无覆盖劣化。',
      interfere_totalverdict: '上行全频段干扰均值-113dBm，SINR低于-3dB采样占比1.1%，无干扰抬升。',
      adj_totalverdict: '邻区核查无漏配；SA切换成功率99.3%；存在同覆盖低负荷异频邻区XA-JD-N78-01。',
      alarm_totalverdict: '传输、驻波、AAU相关活动告警均为0。',
      param_totalverdict: '跨站负载均衡及异频连接态MLB均开启，SA_USER策略已配置；MlbDirection为DOWNLINK，仅覆盖下行负荷，忙时上行拥塞时需评估改为DUAL。',
      analysis_date: date, outside_type: 'his013', degradation_time: date+' 18:00—21:59' },
    analysis_window: { start: date + 'T00:00:00+08:00', end: '2026-11-02T00:00:00+08:00' },
    parameters: { MlbDirection:'DOWNLINK', MlbDirection_allowed_values:['DOWNLINK','UPLINK','DUAL'],
      inter_gnb_mlb:'ON', inter_frequency_connected_mlb:'ON', MlbUeSelectStrategy:'SA_USER',
      MlbTriggerMode:'CELL_USER_NUM', MlbDecisionPeriod:10, source_arfcn:499200, source_scs:30, source_azimuth:100,
      approved_action:'MlbDirection: DOWNLINK→DUAL', rollback_value:'DOWNLINK',
      resource_release_share_percent:82, rule_version:'20261101', software_profile:'NR-n41-20261101' },
    neighbors:[{object_id:'XA-JD-N78-01',cell_name:'建大东校区异频承载小区',arfcn:641280,scs:30,azimuth:112,
      azimuth_difference:12,relation_exists:true,handover_allowed:true,mlb_interaction_allowed:true,
      rolling_window_days:7,statistics_as_of:date,ul_prb_max_percent:26,dl_prb_max_percent:28,rrc_max:128}],
    alarms:{snapshot_date:date,active:[],transport_count:0,vswr_count:0,aau_count:0},
    evaluation_policy:{primary_metric:'his013',target_drop_rate_percent:.8,ul_prb_target_percent:75,
      handover_success_guardrail_percent:99,neighbor_prb_guardrail_percent:70,observation_minutes:60,
      rollback:'掉线率较调整前增加0.5个百分点或连续两窗口切换成功率低于99%时回退DOWNLINK'},
    observations, rules:archiveRules(record), metric_definitions:definitions.filter(row=>row.system==='5G') }
}
function lte(record) {
  const source_ref = `network://20261101/${record.ticket.id}`, observations=[]
  for(let index=0;index<96;index++) {
    const hour=Math.floor(index/4), busy=hour>=18&&hour<=21
    for(const [column,value] of Object.entries({his002:busy?94.2+(hour-18)*.2:99.5,his001:busy?96.8:99.8,
      his007:99.4,his023:busy?56:32,his024:busy?61:38,his020:busy?260:98,his021:busy?390:170,his040:98.6,his045:1.3})) {
      observations.push(observation('4G',column,value,record.ticket.cell_id,index,source_ref))
    }
  }
  const conclusion='主要原因：接入调度参数配置不适配，上行接入用户调度优化开关UlRaUserSchOptSw为0；忙时无线接通率94.2%—94.8%，E-RAB建立成功率96.8%，接入资源调度失败占接入失败72%。次要原因：TDD HARQ-ACK反馈模式配置优化开关为1，与本小区配置建议关闭不一致。覆盖、干扰、切换和设备告警正常，无异频测量触发不足证据。'
  return {ticket_id:record.ticket.id,snapshot_date:date,source_ref,
    provenance:{origin:'constructed',authorization:'user_requested_20261101_supplement',archive_source:record.source_ref},
    order_patch:{conclusion,smart_conclusion:'优先检查接入用户调度与HARQ反馈配置；按原初案比较开关调整，不因低接通标签自动采用测量门限动作。',
      param_totalverdict:conclusion,resource_totalverdict:'忙时上行PRB56%、下行61%，负荷未超过本次80%分析阈值。',
      cover_totalverdict:'MR覆盖率98.6%，弱覆盖占比1.4%。',interfere_totalverdict:'无上行干扰抬升，SINR低于-3dB比例1.3%。',
      adj_totalverdict:'邻区无漏配、切换成功率99.4%。',alarm_totalverdict:'传输、驻波、AAU活动告警均为0。',analysis_date:date,outside_type:'his002',degradation_time:date+' 18:00—21:59'},
    analysis_window:{start:date+'T00:00:00+08:00',end:'2026-11-02T00:00:00+08:00'},
    parameters:{UlSchSwitch:'UlRaUserSchOptSw-0',HarqAlgoSwitch:'TddAckFbModeCfgOptSwitch-1',SNonIntraSearch:'20',
      PucchIrcSwitch:'ON',rule_version:'20261101',software_profile:'LTE-TDD-F-20261101'},
    neighbors:[],alarms:{snapshot_date:date,active:[],transport_count:0,vswr_count:0,aau_count:0},
    evaluation_policy:{primary_metric:'his002',target_access_rate_percent:99,observation_minutes:60,
      rollback:'接通率较调整前降低0.5个百分点或出现新告警时恢复对应开关原值'},
    observations,rules:archiveRules(record),metric_definitions:definitions.filter(row=>row.system==='4G')}
}
try {
  for(const [id,build] of [['SNXIA512260630163682851377932320',nr],['SNWNA011260503851110229964',lte]]) {
    const record=archive({operation:'read',ticket_id:id})
    if(record.status!=='found') throw new Error('请先导入工单库：'+id)
    console.log(JSON.stringify(store.write(build(record))))
  }
} finally { archive.close(); store.close() }
