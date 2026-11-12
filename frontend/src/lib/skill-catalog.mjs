const titles = {
  'wireless-workorder-orchestrator': '综合网优编排',
  'wireless-workorder-intake': '工单查询与信息总结',
  'wireless-problem-identification': '问题识别',
  'wireless-objective-confirmation': '目标确认',
  'wireless-evidence-builder': '证据整理',
  'wireless-data-analysis': '指标与数据分析',
  'wireless-root-cause-analysis': '根因分析',
  'wireless-case-retrieval': '历史案例检索',
  'wireless-solution-decision': '方案生成与择优',
  'wireless-cause-plan-alignment': '根因与方案对齐',
  'wireless-parameter-adaptation': '参数适配与风险检查',
  'wireless-plan-consistency': '整单一致性复核',
  'wireless-comprehensive-decision': '综合决策',
  'wireless-effect-evaluation': '效果评价',
  'wireless-multi-round-reasoning': '多轮优化推理',
  'wireless-memory-engineering': '工单与经验记录',
  'wireless-knowledge-compiler': '历史经验编译',
  'wireless-echo-mem': '历史经验使用方法',
  'wireless-demo-analysis': '场景综合分析',
};

export const skillTitle = name => titles[name] || name;
