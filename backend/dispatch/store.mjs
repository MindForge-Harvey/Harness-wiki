import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { agents, capabilities, metrics } from './catalog.mjs';
import { hierarchyCatalog } from './hierarchy.mjs';
import { releaseSource } from './release-functions.mjs';

export function createDispatchStore({ now = new Date() } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE grids(id TEXT PRIMARY KEY, name TEXT, aliases TEXT, boundary TEXT);
    CREATE TABLE cells(id TEXT PRIMARY KEY, name TEXT, grid_id TEXT, site_id TEXT, vendor TEXT, system TEXT, lat REAL, lon REAL, problem TEXT, parameters TEXT);
    CREATE TABLE metrics(cell_id TEXT, metric TEXT, at TEXT, value REAL, PRIMARY KEY(cell_id,metric,at));
    CREATE TABLE complaints(id TEXT PRIMARY KEY, grid_id TEXT, cell_id TEXT, at TEXT, address TEXT, phenomenon TEXT, business TEXT, b_reason TEXT, user_label TEXT);
    CREATE TABLE alarms(id TEXT PRIMARY KEY, cell_id TEXT, at TEXT, name TEXT, severity TEXT);
    CREATE TABLE knowledge(id TEXT PRIMARY KEY, title TEXT, text TEXT, tags TEXT);
    CREATE TABLE cases(id TEXT PRIMARY KEY, title TEXT, problem TEXT, action TEXT, result TEXT);
    CREATE TABLE mr_coverage(cell_id TEXT, at TEXT, samples INTEGER, good_samples INTEGER, scene TEXT, PRIMARY KEY(cell_id,at));
    CREATE TABLE neighbors(source_id TEXT,target_id TEXT,enabled INTEGER,attempts INTEGER,successes INTEGER,PRIMARY KEY(source_id,target_id));
    CREATE TABLE demo_orders(taskno TEXT PRIMARY KEY,grid_id TEXT,cell_id TEXT,created_at TEXT,closed_at TEXT,status TEXT,problem TEXT,source_scenario TEXT);
    CREATE TABLE capabilities(id TEXT PRIMARY KEY, body TEXT);
    CREATE TABLE runs(id TEXT PRIMARY KEY, owner_uid TEXT, body TEXT);
    CREATE TABLE jobs(id TEXT PRIMARY KEY, run_id TEXT, body TEXT);
    CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, body TEXT);
    CREATE INDEX metric_lookup ON metrics(metric,at,cell_id);
  `);
  const seededAt = now.toISOString();
  const end = new Date(Math.floor(+now / 3600000) * 3600000);
  const start = new Date(+end - 14 * 86400000);
  const grids = [
    { id: 'GRID-XJK', name: '新街口商圈', aliases: ['新街口', '新街口网格', '南京新街口'], lat: 32.0418, lon: 118.7843 },
    { id: 'GRID-HX', name: '河西商务区', aliases: ['河西', '河西网格', '奥体中心'], lat: 32.0020, lon: 118.7296 },
    { id: 'GRID-XL', name: '仙林大学城', aliases: ['仙林', '仙林网格', '大学城'], lat: 32.1089, lon: 118.9212 },
  ];
  const insertGrid = db.prepare('INSERT INTO grids VALUES(?,?,?,?)');
  const insertCell = db.prepare('INSERT INTO cells VALUES(?,?,?,?,?,?,?,?,?,?)');
  const insertMetric = db.prepare('INSERT INTO metrics VALUES(?,?,?,?)');
  const insertComplaint = db.prepare('INSERT INTO complaints VALUES(?,?,?,?,?,?,?,?,?)');
  const insertAlarm = db.prepare('INSERT INTO alarms VALUES(?,?,?,?,?)');
  const cellNames = ['中心广场', '商业中心', '地铁口', '东侧居民区'];
  db.exec('BEGIN');
  grids.forEach((grid, gi) => {
    insertGrid.run(grid.id, grid.name, JSON.stringify(grid.aliases), JSON.stringify([
      [grid.lon - .008, grid.lat - .006], [grid.lon + .008, grid.lat - .006], [grid.lon + .008, grid.lat + .006], [grid.lon - .008, grid.lat + .006],
    ]));
    for (let ci = 0; ci < 4; ci++) {
      const id = `${['XJK', 'HX', 'XL'][gi]}-NR-${String(ci + 1).padStart(3, '0')}`;
      const problem = gi === 0 ? ['capacity', 'capacity', 'handover', 'coverage'][ci] : gi === 1 ? ['capacity', 'normal', 'normal', 'coverage'][ci] : ['interference', 'access', 'coverage', 'normal'][ci];
      const parameters = { load_balance_trigger: { label: '负荷均衡触发门限', value: 85, min: 50, max: 95, step: 5, unit: '%' },
        handover_offset: { label: '切换偏置', value: 0, min: -6, max: 6, step: 1, unit: 'dB' },
        electrical_tilt: { label: '电下倾角', value: 8, min: 2, max: 12, step: 1, unit: '°' },
        ul_power_control: { label: '上行功控偏置', value: 0, min: -3, max: 3, step: 1, unit: 'dB' },
        access_preamble: { label: '随机接入前导配置', value: 32, min: 16, max: 64, step: 16, unit: '个' } };
      insertCell.run(id, `${grid.name}${cellNames[ci]}-5G`, grid.id, `${['XJK', 'HX', 'XL'][gi]}-S${Math.floor(ci / 2) + 1}`, ci % 2 ? '中兴' : '华为', 'NR', grid.lat + (ci < 2 ? .002 : -.002), grid.lon + (ci % 2 ? .0035 : -.0035), problem, JSON.stringify(parameters));
      for (let hour = 0; hour < 14 * 24; hour++) {
        const at = new Date(+start + hour * 3600000).toISOString();
        const localHour = (new Date(at).getUTCHours() + 8) % 24;
        const peak = localHour >= 18 && localHour <= 22;
        const wave = Math.sin(hour * .71 + ci + gi) * 2.1;
        const values = {
          prb: (problem === 'capacity' ? (peak ? 94 : 77) : peak ? 65 : 42) + wave,
          dl_rate: (problem === 'capacity' ? (peak ? 7.8 : 16) : problem === 'coverage' ? 11 : 43) + wave,
          rrc_success: (problem === 'coverage' ? 96.1 : problem === 'access' ? 96.4 : 99.35) + wave * .07,
          handover_success: (problem === 'handover' ? 91.2 : 99.05) + wave * .09,
          rsrp: (problem === 'coverage' ? -116 : -91) + wave,
          sinr: (problem === 'coverage' ? 3.7 : problem === 'interference' ? 4.2 : 15) + wave * .3,
          ul_interference: (problem === 'interference' ? -86 : -111) + wave * .4,
          drop_rate: (problem === 'handover' ? 2.7 : .3) + wave * .03,
        };
        metrics.forEach(metric => insertMetric.run(id, metric.id, at, Number(values[metric.id].toFixed(2))));
      }
      for (let day = 0; day < 14; day++) {
        const samples = 5000 + ci * 137 + day * 17, ratio = problem === 'coverage' ? .42 : .96;
        const scene = gi === 2 && ci < 2 ? '高校' : ci === 2 ? '地铁' : ci === 3 ? '高层居民区' : gi === 1 ? '写字楼' : '商业中心';
        db.prepare('INSERT INTO mr_coverage VALUES(?,?,?,?,?)').run(id, new Date(+end - day * 86400000 - 6 * 3600000).toISOString(), samples, Math.round(samples * ratio), scene);
      }
      for (let offset = 1; offset <= 2; offset++) {
        const target = `${['XJK', 'HX', 'XL'][gi]}-NR-${String((ci + offset) % 4 + 1).padStart(3, '0')}`;
        db.prepare('INSERT INTO neighbors VALUES(?,?,?,?,?)').run(id, target, problem === 'handover' && offset === 1 ? 0 : 1, 1000, problem === 'handover' ? 912 : 992);
      }
      const count = problem === 'capacity' ? 14 : problem === 'normal' ? 2 : 9;
      for (let j = 0; j < count; j++) {
        const at = new Date(+end - ((j % 7) * 24 + (ci * 2 + j) % 12 + 1) * 3600000).toISOString();
        const bReason = j % 7 === 0 ? '套餐达量限速' : j % 13 === 0 ? '终端能力受限' : null;
        insertComplaint.run(`CP-${gi + 1}${ci + 1}${String(j + 1).padStart(3, '0')}`, grid.id, id, at,
          `${grid.name}${cellNames[ci]}${j % 3 + 1}号楼`, problem === 'handover' ? '移动时通话断续' : problem === 'coverage' ? '室内信号弱、网页加载慢' : '晚高峰下载慢、视频卡顿',
          problem === 'handover' ? '语音' : '数据', bReason, `演示用户 ${gi + 1}${ci + 1}${j + 1}`);
      }
      if (problem === 'coverage' || problem === 'handover') insertAlarm.run(`AL-${id}`, id, new Date(+end - 20 * 3600000).toISOString(),
        problem === 'coverage' ? '天馈驻波异常（演示）' : '邻区配置核查提示（演示）', 'warning');
    }
  });
  const knowledge = [
    ['KN-001', '高负荷与低速率的联合研判', '演示判据：PRB 均值高于 75% 且下行用户速率低于 20 Mbps 时，形成容量受限假设。需结合忙时、用户数及邻区余量核验，单一指标不能证明根因。', '容量 高负荷 PRB 速率 下载 视频'],
    ['KN-002', '弱覆盖问题的证据与处置', '演示判据：平均 RSRP 低于 -110 dBm 为弱覆盖线索。结合天馈告警、室内外位置和配置分析；现场物理故障需要现场处置，远程参数调整可能无法解决。', '覆盖 RSRP 信号 室内 天馈'],
    ['KN-003', '切换问题与邻区核查', '演示判据：切换成功率低于 95% 作为切换质差线索，核验邻区与切换参数，记录调整前值和回退条件。', '切换 掉话 邻区 语音 移动'],
    ['KN-004', '投诉中的非无线问题定界', '先检查套餐达量限速和终端能力等 B 域信息，将非无线问题单独输出；避免把套餐限速直接归因为小区覆盖或容量。', '投诉 B域 套餐 限速 终端'],
    ['KN-005', '优化评估与保护指标', '演示评估规则：容量目标 PRB 不高于 75%、速率不低于 20 Mbps；覆盖目标 RSRP 不低于 -110 dBm；切换目标成功率不低于 95%。模拟执行产生独立观测快照，评估读取实际回执；观察窗不足时保持观察中。', '评估 效果 优化 规则 保护 回退'],
    ['KN-006', '区域协同与相邻小区保护', '按站点、小区和问题类型聚合，区分区域共性问题与局部覆盖短板。方案检查同时关注同站冲突和邻区负荷，给出协同保护对象。', '区域 协同 多小区 网格'],
  ];
  const insertKnowledge = db.prepare('INSERT INTO knowledge VALUES(?,?,?,?)');
  knowledge.forEach(row => insertKnowledge.run(...row));
  [
    ['KN-007', '上行干扰与弱覆盖的区分', '演示判据：SINR 低于7 dB且上行干扰噪声高于-100 dBm时形成干扰线索。低SINR不单独证明干扰，需要结合覆盖信号、告警和测量核验。', '干扰 上行 SINR 噪声'],
    ['KN-008', '六维诊断的证据口径', '发布包定义覆盖、邻区、参数、干扰、告警、资源六维。各维按可用观测独立留证，缺失维度保留未评估，不以正常或通过代替缺数。', '六维 覆盖 邻区 参数 干扰 告警 资源'],
    ['KN-009', '规则取值和风险依据', '发布包按para与rule_scope计算约束和一步目标值。多值、带前缀区间或空约束的源策略是直通建议，不能表示已做硬约束校验；演示执行仍需独立校验。源模块不具备已供数的参数风险分级。', '规则 参数 步长 风险 约束'],
    ['KN-010', '短评估与回退记录', '源代码区分改善、恶化、缺失。执行失败或评估缺失不能记作成功。回退需绑定原执行记录和执行前值，生成独立回退回执。', '短评估 回退 效果 闭环'],
    ['KN-011', 'MR覆盖率的分子分母', '覆盖率按好覆盖采样数除以上报采样总数计算。跨小区先汇总分子分母，不能平均百分比，也不能用平均RSRP推算MR覆盖率。', 'MR 覆盖率 采样 弱覆盖 高校 地铁'],
  ].forEach(row => insertKnowledge.run(...row));
  const insertCase = db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)');
  [['CASE-001', '商圈晚高峰容量优化', 'capacity', '降低演示负荷均衡触发门限，核验邻区余量', '演示案例：忙时速率改善，需持续观察邻区'],
    ['CASE-002', '地铁口切换质差优化', 'handover', '核查邻区并调整演示切换偏置', '演示案例：切换成功率改善'],
    ['CASE-003', '居民区室内弱覆盖', 'coverage', '核查天馈告警并派发现场排障', '演示案例：单独调参不足，需现场处理']].forEach(row => insertCase.run(...row));
  [['CASE-004', '高校上行干扰排查', 'interference', '联合SINR与上行噪声，检查干扰源及功控', '演示案例：需区分信号弱与外部干扰'],
    ['CASE-005', '随机接入质差排查', 'access', '核查接入参数与成功率', '演示案例：参数建议仍需按当前约束审核']].forEach(row => insertCase.run(...row));
  const orderStates = ['Succeed', 'Succeed', 'WaitingEval', 'ReasoningFailed', 'LinkFailed', 'TimeoutFailed', 'Received', 'Succeed'];
  grids.forEach((grid, gi) => orderStates.forEach((status, i) => {
    const created = new Date(+end - (i * 13 + gi * 2 + 5) * 3600000), closed = ['Succeed', 'ReasoningFailed', 'LinkFailed', 'TimeoutFailed'].includes(status) ? new Date(+created + (i + 1) * 12 * 60000).toISOString() : null;
    db.prepare('INSERT INTO demo_orders VALUES(?,?,?,?,?,?,?,?)').run(`WO-DEMO-${gi + 1}-${i + 1}`, grid.id, `${['XJK', 'HX', 'XL'][gi]}-NR-${String(i % 4 + 1).padStart(3, '0')}`, created.toISOString(), closed, status,
      ['容量受限', '弱覆盖', '切换质差', '干扰'][i % 4], ['happy_path', 'deteriorated_then_success', 'waiting_evaluation', 'deteriorated_twice', 'push_retry_exhausted', 'icos_handled', 'received', 'push_retry_then_success'][i]);
  }));
  capabilities.forEach(item => db.prepare('INSERT INTO capabilities VALUES(?,?)').run(item.id, JSON.stringify(item)));
  db.exec('COMMIT');

  const runs = new Map(), jobs = new Map();
  const saveRun = run => { runs.set(run.id, run); db.prepare('INSERT OR REPLACE INTO runs VALUES(?,?,?)').run(run.id, run.ownerUid, JSON.stringify(run)); return run; };
  const saveJob = job => { jobs.set(job.id, job); db.prepare('INSERT OR REPLACE INTO jobs VALUES(?,?,?)').run(job.id, job.runId, JSON.stringify(job)); return job; };
  const allGrids = () => db.prepare('SELECT * FROM grids').all().map(row => ({ ...row, aliases: JSON.parse(row.aliases), boundary: JSON.parse(row.boundary) }));
  const allCells = () => db.prepare('SELECT * FROM cells').all().map(row => ({ ...row, parameters: JSON.parse(row.parameters) }));
  return {
    db, runs, jobs, seededAt, dataStart: start.toISOString(), dataEnd: end.toISOString(), saveRun, saveJob,
    id: prefix => `${prefix}-${randomUUID().slice(0, 8)}`,
    grids: allGrids, cells: allCells,
    scopeCells(scope = {}) {
      const gridIds = scope.grid_ids || [], cellIds = scope.cell_ids || [];
      return allCells().filter(cell => cellIds.length ? cellIds.includes(cell.id) : gridIds.includes(cell.grid_id));
    },
    event(run, type, detail = {}) {
      const event = { type, at: new Date().toISOString(), ...detail };
      const result = db.prepare('INSERT INTO events(run_id,body) VALUES(?,?)').run(run.id, JSON.stringify(event));
      event.seq = Number(result.lastInsertRowid); run.events.push(event); saveRun(run); return event;
    },
    overview() {
      return { grids: allGrids(), cells: allCells(), metrics, agents: agents.map(agent => ({ ...agent, status: 'online', capabilityCount: capabilities.filter(c => c.agentId === agent.id).length })),
        ...hierarchyCatalog(), releaseSource, data: { source: '内存演示数据', seededAt, start: start.toISOString(), end: end.toISOString(),
          cells: db.prepare('SELECT count(*) AS n FROM cells').get().n, complaints: db.prepare('SELECT count(*) AS n FROM complaints').get().n,
          observations: db.prepare('SELECT count(*) AS n FROM metrics').get().n, orders: db.prepare('SELECT count(*) AS n FROM demo_orders').get().n } };
    },
    close() { db.close(); },
  };
}
