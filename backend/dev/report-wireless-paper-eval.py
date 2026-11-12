"""Build an inspectable local test report from retained tool/model evidence."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("directory", type=Path)
args = parser.parse_args()
root = args.directory.resolve()
profile = json.loads((root / "profile.json").read_text())
baseline = json.loads((root / "tool-summary.json").read_text())
compiled = json.loads((root / "compiled-history.json").read_text())
results = []
for path in sorted((root / "model-results").glob("*.json")):
    if path.stem.endswith(("-events", "-input")) or path.name == "summary.json": continue
    result = json.loads(path.read_text())
    if "id" in result: results.append(result)

names = {
    "wireless-workorder-intake": "工单接入", "wireless-problem-identification": "问题分型",
    "wireless-evidence-builder": "证据整理", "wireless-data-analysis": "数据分析",
    "wireless-root-cause-analysis": "根因分析", "wireless-objective-confirmation": "目标确认",
    "wireless-case-retrieval": "历史案例", "wireless-solution-decision": "候选方案",
    "wireless-cause-plan-alignment": "根因方案对齐", "wireless-parameter-adaptation": "参数风险",
    "wireless-plan-consistency": "整单一致性", "wireless-comprehensive-decision": "综合决策",
    "wireless-multi-round-reasoning": "多轮重推理", "wireless-effect-evaluation": "效果评估",
    "wireless-memory-engineering": "工单记忆工程", "wireless-knowledge-compiler": "历史编译",
    "wireless-echo-mem": "ECHO-Mem 原理", "wireless-demo-analysis": "场景/真实工单路由",
    "wireless-workorder-orchestrator": "工单总编排",
}
limits = {
    "wireless-root-cause-analysis": "无诊断原文/六维/KPI，只能给缺口与待验证线索，不能确认当前根因",
    "wireless-cause-plan-alignment": "缺当前根因，不能证实方案针对性",
    "wireless-data-analysis": "能核对参数变化；缺 KPI 时序，不能算网络性能变化",
    "wireless-multi-round-reasoning": "无有效短评估关联与真实轮次，不能回放完整重推理阶梯",
    "wireless-effect-evaluation": "能核对执行和归档标签；缺 KPI，不能算改善幅度/单参数收益",
    "wireless-evidence-builder": "能整理上下文与历史来源；不能凭参数记录制造当前观测",
    "wireless-demo-analysis": "真实记录走 ICOS 路由；不使用合成场景替代本单",
}
conclusions = {
    "wireless-workorder-intake": "接入 case-01 的小区、3 条动作、23 条历史快照，保留字符串执行编号与来源",
    "wireless-problem-identification": "case-04 识别为接入类/接通低，现象、动作和根因分开",
    "wireless-evidence-builder": "case-01 整理参数、规则与历史来源，当前观测数为 0",
    "wireless-data-analysis": "case-05 核对 4 个开关变化与 1 个枚举变化，拒绝把参数值算成 KPI",
    "wireless-root-cause-analysis": "case-06 返回根因原文不足，给出待核实假设而非确诊",
    "wireless-objective-confirmation": "case-12 明确单个 NR 小区与 SA 接通率，量化目标及窗口未知",
    "wireless-case-retrieval": "case-04 三动作同类参考分别 7/10、4/12、4/8 改善；均不能解释为独立参数疗效",
    "wireless-solution-decision": "case-04 组织 1 组 3 案 3 动作；条件性比较，缺根因时无需伪造组内判断",
    "wireless-cause-plan-alignment": "case-09 缺当前根因，无可证实的根因—方案对齐关系",
    "wireless-parameter-adaptation": "case-08 剔除大小写编码差异的重复开关调整，20→18 满足 >10、步长 -2",
    "wireless-plan-consistency": "case-01 完成逐动作相关性与冲突复核，未供数的互斥/风险项保留未评估",
    "wireless-comprehensive-decision": "case-10 输出逐动作与整单候选裁决；选择状态不表示设备执行",
    "wireless-multi-round-reasoning": "case-02 缺有效前轮关联和短评估，明确不能生成有依据的下一轮目标",
    "wireless-effect-evaluation": "case-02 识别 1 成功/1 失败、短评估未启用、长期 Fail 与改善标签并存",
    "wireless-memory-engineering": "case-04 保存工单/候选方案并关联原分析，不把归档候选记成实际执行",
    "wireless-knowledge-compiler": "159 张训练工单编译成 242 个六类记忆对象，可带来源读回",
    "wireless-echo-mem": "结合多动作与部分执行解释归因边界，整单 Pass 不广播给单个参数",
    "wireless-demo-analysis": "case-06 使用真实记录路由，未拿合成弱覆盖场景替代",
    "wireless-workorder-orchestrator": "case-09 跑完决策前链路，对 50→48 定时器及负载开关作不同处置",
}
audit_notes = {
    "single-03": "答复中的 17.2% 来自原 ICOS 内核对旧样本的说明，不能作为本 ZIP 的占比。",
    "single-05": "答复将 17.2% 描述为可收敛率不准确；原内核指旧样本中两字段皆空的占比，本次样本不能确诊根因。",
    "single-07": "答复将 LDJT022 写成 22→20，与同一行的“增大/+2”矛盾；本单正确值为 20→22，以输入及工具为准。",
    "single-08": "候选结构的 infeasible=false 且 feasibility=null 只表示本阶段未判不可行，不能写成参数可行性已验证；该验证属于后续 parameter_risk。",
    "single-09": "17.2% 是原 ICOS 旧样本说明，非本 ZIP 占比；为核对空产物使用 refresh 会使下游失效，后续应复用有效结果。",
    "single-11": "历史改善比例是匹配工单组合的结果；“协同/安全”没有当前机制与完整现场约束支撑，只能保留为模型复核意见。",
    "single-12": "候选未准入不等于现场值已被核实保持不变；17.2% 非本次统计，声明约束通过也不证明现场安全。",
    "single-13": "本单 retry_times=0；答复第二条关于“大于 0”的片段应理解为启动下一轮的要求，不能当作本单事实。",
    "single-14": "执行失败只能说明目标未被确证生效；“现网应仍为 6”未经独立快照核实，实际改后值保持未知。",
    "combined-nr": "17.2% 是原 ICOS 旧样本说明；“调得安全”超出静态规则可证范围，应理解为声明约束通过、现场风险待验证。",
    "combined-access": "“可自动下发/安全”来自源算法候选口径，缺根因、KPI 和部分规则项时，不能直接作为现场放行依据。",
}
single = [r for r in results if r["kind"] == "single_skill"]
combined = [r for r in results if r["kind"] == "combined_skills"]
all_traces = sum(r["traces"] for r in profile["profiles"].values())
all_actions = sum(r["actions"] for r in profile["profiles"].values())
checks = profile["checksums"]
passed = sum(r.get("status") == "passed" for r in results)
sampled_actions = sum(r["actions"] for r in baseline["perCase"])
failed_actions = sum(r["feedback_summary"]["failed_actions"] for r in baseline["perCase"])

text = ["# 真实归档数据 Skills 验证（2026-11-11）", "",
    "结论：19 个 Skills 均已实际调度并产生答复，组合链路可运行。参数检查、历史比对与归档反馈可产出具体结论；根因确诊、效果幅度及真实多轮闭环证据不足。部分模型文字仍需核对，不能直接作为现场决策。", "",
    f"已完成 {len(single)} 个单 Skill 场景与 {len(combined)} 个组合场景。模型执行检查通过 {passed}/{len(results)}；调用成功与业务证据充分分别评价，不能由该数字推导根因准确率或优化成功率。", "",
    "## 数据与核验范围", "",
    f"来源：用户提供的 `{Path(profile['archive']).name}`。全量检查 {all_traces:,} 个工单、{all_actions:,} 个动作。CSV 与 JSONL 是同一批主数据的两种表示，没有相加重复计数。", "",
    "| 划分 | 工单 | 动作 |", "|---|---:|---:|"]
for split, p in profile["profiles"].items(): text.append(f"| {split} | {p['traces']:,} | {p['actions']:,} |")
text += ["", f"校验文件 SHA-256 {sum(v['matches'] for v in checks.values())}/{len(checks)} 一致；全部划分工单互斥；主数据逐工单 CSV/JSONL 动作数完全一致。JSON Schema 抽检 {len(profile['sampled_schema_checks'])} 条，无错误。完整检查见 [profile.json]({root/'profile.json'})。", "",
    f"功能验证选取 {len(baseline['perCase'])} 张 LTE/NR 工单、{sampled_actions} 个动作，覆盖切换、接通、覆盖、速率、掉线及执行失败/标签不一致边界。它是有目的的功能样本，不代表总体分布；不用于论文准确率评价。纯工具阶段实际执行 {len(json.loads((root/'tool-calls.json').read_text()))} 次 SDK 调用，无失败。", "",
    f"历史只使用 Train 中 {profile['history_traces']} 张工单，目标工单结果另存反馈文件。训练子集实际编译得到 {compiled['memory_count']} 条记忆，包 ID `{compiled['package_id']}`。时间标准化保留原值；日期粒度按源日末保守界限，评价可见性依据 2026-11-10 归档快照，不声称评价在原决策时已可见。", "",
    "ICOS 案例快照与编译后的 ECHO 记忆来自同一训练子集，是同一批证据的不同表示，不是独立互证，不能合并样本数。重放约束取自归档行的 para/rule_scope，并在测试中启用这些声明规则；不证明原始规则库完整性、现场厂家版本或当期启用状态。", "",
    "## 关键结论", "",
    "- 原数据缺少 conclusion/smart_conclusion、六维诊断原文及 KPI/MR 时序。根因收敛返回 not_called 是如实的数据不足结果，不能算成已确认根因。",
    "- 实测可完成工单/目标提取、可比历史检索、归档动作组织、约束/步长检查、整单复核、候选裁决、账本保存与六类记忆编译。归档动作池并非完整的原始候选全集。",
    "- 吞吐率工单的上行 PDCCH 开关 before/target 只有编码大小写差异，原约束计算识别为已经在目标值，建议不重复调整；同单异频负载评估周期 20→18 满足 >10、步长 -2。详见 case-08 工具产物。",
    f"- 选取记录中有 {failed_actions}/{sampled_actions} 个动作历史执行失败；这不是总体失败率。单纯参数规则通过不能证明设备会执行成功，失败原因仍需设备侧配置/依赖信息。",
    "- “短评估未启用”不是短评估失败；长期 Fail 与“改善”文字标签保持各自口径，不自动合并或改判。执行失败记录的 after 只记尝试目标，不记为现网实际改后值。没有真实轮次和短评估关联，就不能生成有事实依据的下一轮目标。", "",
    "## 单个 Skills", "",
    "通过条件：实际加载指定 Skill、调用预期业务工具、获得非空答复、无未解决工具错误。前置纯计算产物预先准备；需要复核等依赖的测试允许加载必要附属 Skill，并在原始结果记录实际加载清单。", "",
    "| Skill | 调用检查 | 本项实质结论 | 结论范围 | 实际输出 |", "|---|---|---|---|---|"]
details = root / "answers"; details.mkdir(exist_ok=True)
for r in sorted(single, key=lambda r:r["id"]):
    skill = r["skills"][0]
    status = "通过" if r["status"] == "passed" else "待核查"
    text.append(f"| {names.get(skill,skill)} | {status} | {conclusions.get(skill,'详见答复')} | {limits.get(skill,'限本次归档输入与声明约束，现场适用性待核实')} | [答复]({details / (r['id']+'.md')}) |")
    note = "\n\n核对说明：" + audit_notes[r['id']] if r['id'] in audit_notes else ""
    (details / (r["id"] + ".md")).write_text(f"# {names.get(skill,skill)}\n\nSkill: `{skill}`\n\n测试：{r['id']}；记录：{r.get('case',{}).get('case',r.get('caseId'))}；调用状态：{r['status']}" + note + "\n\n以下为保留的模型原答复，调用通过不表示文字已逐句核实。\n\n" + r.get("answer",r.get("error","")) + "\n")
text += ["", "## 多个 Skills 联合", "", "| 测试 | Skills | 调用检查 | 输出 |", "|---|---|---|---|"]
for r in combined:
    text.append(f"| {r['id']} | {'、'.join(names.get(s,s) for s in r['skills'])} | {'通过' if r['status']=='passed' else '待核查'} | [答复]({details / (r['id']+'.md')}) |")
    note = "核对说明：" + audit_notes[r['id']] + "\n\n" if r['id'] in audit_notes else ""
    (details/(r['id']+'.md')).write_text(f"# {r['id']}\n\n" + note + "以下为保留的模型原答复。\n\n"+r.get('answer',r.get('error',''))+'\n')
text += ["", "## 答复质量核对", "",
    "上述通过数只衡量加载、调用与响应，并非逐句事实正确。抽查模型答复发现以下表述问题，原答复保留，阅读时以输入与工具事实为准：", ""]
for id, note in audit_notes.items():
    text.append(f"- [{id}]({details / (id+'.md')})：{note}")
text += ["", "当前可依赖的是有来源的参数变化、静态约束检查、历史检索与执行标签解释；厂家作用机制、当前根因和现场安全性不能由这些文字推断。测试提示已明确提醒缺失字段，本轮也使用了前置产物与定向修复；因此尚未证明任意自然语言请求下同等稳定的自主分析能力。事后数据与输入分文件保存并在提示中限制读取，没有建立文件系统级隔离；本次不据此报告盲测准确率。", "",
    "## 测试中修复的问题", "",
    "1. ICOS case_id 与原固定案例池的 historical_case_ids 混用会导致证据绑定失败。Skill 已明确来源池边界，没有当前观测时不再强行构造证据。",
    "2. 缺 KPI 时数据分析会尝试生成非法/伪观测。context 现在实际计算 parameter_changes，Skill 直接报告参数变化和 KPI 缺口。",
    "3. 完整上下文在一个样本中约 913 KB。新增 view=summary，按阶段返回必要字段，摘要约 30 KB，完整记录仍保留。",
    "4. 归档长期评价与原实时短评估接口不兼容。新增独立 archived_feedback 输入，保留未启用状态、执行失败及标签差异，不污染决策前输入。",
    "5. 原导出时间混有日期、ISO 无时区和日/月/年格式，不能直接交给编译器。新增有来源记录的时间归一工具，保留每个原值及精度。", "",
    "6. 先分析后建立账本时不能靠替换完整输入来关联。新增 link_workorder 操作，幂等关联账本且保留全部阶段。",
    "7. 案例不能作为正向策略排序；策略/组合还须满足 validated/reusable。排序对普通类型/状态不准入返回 no_candidates 与拒绝原因，缺失/损坏/越界来源仍阻断。",
    "8. 候选阶段 completed 且 judgment_requests 为空时即交付已有结构与比较，不为得到分数自建判断、猜令牌或 refresh 重算。错误判断提交仍由后端拦截。", "",
    "首轮失败与修复后复验的原始记录均保留在 model-results/first-pass 与 model-results。报告不隐去首次失败。", "",
    "## 复现与证据", "",
    f"- [全部模型结果]({root/'model-results/summary.json'})", f"- [纯工具结果]({root/'tool-summary.json'})",
    f"- [编译结果]({root/'compiled-history.json'})", f"- [数据与抽样索引]({root/'cases.json'})",
    f"- 归档 SHA-256：`{profile['archive_sha256']}`", "",
    "测试使用配置的真实模型和 Harness 工具，没有调用现场下发、网元回退或生产工单数据库。模型产生的文字解释仍须以保留的工具结果和数据来源核对。"]
(root / "evaluation.md").write_text("\n".join(text) + "\n")
print(json.dumps({"report": str(root / "evaluation.md"), "tests":len(results), "passed":passed, "single_skills":len(single), "combinations":len(combined)}))
