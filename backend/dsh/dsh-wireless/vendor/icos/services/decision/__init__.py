"""决策事实层 —— 后端**真正据以裁决**的那些事实，及其唯一的成品表述。

本包回答的是「这张工单本轮为什么是这个下场」：哪些初案挂在哪条根因上、每个参数动作
各自什么下场、锚点与步长把取值框在哪里、整单能不能自动下发。这些全部是
``agent_execution_plan`` / ``icos_initial_plan_record`` 上的既成事实，本包基本只做收敛与
转写，**很少新做判断** —— 例外各自在自己那一节里说明了理由：
``action_facts`` 的「域内余量」是新算的量；``rule_assessment``（决策步 07 参数风险评估）
则更进一步，**亲自预演**一遍规则匹配与取值约束判定；``arbitration``（决策步 08）裁定
同参数多目标值时谁留谁去；``chain``（决策链）把 04 → 07 → 08 → 决策条件回环整条算一遍，
定每个参数发不发、发什么值。除这几处外，本包不自己下判断。

为什么它不在 ``services/frontend_view`` 里
------------------------------------------
它曾经在。改版前界面上的"决策过程"是展示层自己判的第二套结论，与后端真决策并行
且不同源；四步统一把展示层降成渲染器之后，这些模块已经是「决策侧的产物」，只是
位置还留在展示包里。放着不动的直接后果是：下一步要让 ``compliance`` /
``decision_service`` 消费它们时，决策链路会反向 import 整个展示包。

依赖规矩（**这是本包存在的理由，破了就等于没搬**）
--------------------------------------------------
* 本包**不得 import** ``services.frontend_view`` 的任何模块。由
  ``tests/test_decision_package.py::test_决策包不依赖展示层`` 钉死。
* 允许的上游只有 ``services.common``（纯工具、配置、日志）与 ``services.compliance``
  （``Phase`` / ``BYPASS_PHASES`` / 数值域解析 —— 决策事实本来就长在合规链路上）。
* 方向是 ``frontend_view → decision``，单向。展示层只读本包的产出，不回灌。

包内各模块的分工
----------------
* :mod:`~services.decision.verdict` —— **类型化裁决对象**（``OrderDecision`` /
  ``ActionVerdict``）。它是上面那句「唯一的成品表述」真正落成类型的地方：裁决被生产
  一次、所有人只读，而不是每个消费者各自从 DB 行推一遍。**它不新写任何推导** ——
  下面三个模块就是它调用的那些单一来源，等价性由 ``tests/test_verdict.py`` 钉死。
  它还顺带把今天已经存在、只是没人看得见的几处口径分歧显性化（推送侧 ``need_call``
  与准入态相反、``root_cause`` 的子串误判、成功路径上的 ``rule_row`` 其实是模型回抄的）。

* :mod:`~services.decision.plan_table` —— 对齐键 ``plan_key``、决策行的
  ``phase → 业务口径`` 翻译（``verdict_row_state``），以及「收到哪些方案组」「这些动作
  各自什么下场」的逐行事实与计数（``icos_plan_facts`` / ``verdict_entries`` /
  ``verdict_stats``）。另外两个模块都依赖它，它谁都不依赖。
* :mod:`~services.decision.convergence` —— **决策步 02 根因收敛**：只认工单
  ``conclusion`` + ``smart_conclusion`` 两个字段，确定性解析出本单根因清单（基准），
  **不用模型**。包内**第二个叶子**，谁都不依赖。注意它与下面那个 ``root_cause``
  名字像、做的是两件事：这里是「收敛」，那里是「对齐」，由
  ``verdict.CauseBasis`` 的两个取值在类型上分开。
* :mod:`~services.decision.root_cause` —— 按初案 ``(type1, type2)`` 分组。那两列同时是
  规则库五元组匹配键的前两位，所以这套根因**就是**决定参数能不能调的那套。它的模块文档
  首行自称「根因收敛」，但按 02 的定义那其实是**决策步 05 根因对齐** —— 改那句话要同时
  打到界面、正文、提示词、推送四条路，单列为一条待办，不在本轮动。
* :mod:`~services.decision.action_facts` —— 域内余量（``domain_margin``）与整单判定
  （``order_dispatch_verdict``）。
* :mod:`~services.decision.order_review` —— 整单复核（相关度标注与冲突注记）的类型化
  产物与词表。
* :mod:`~services.decision.rule_assessment` —— **决策步 07 参数风险评估**的规则库确定性结论：
  在任何大模型之前，对一条初案参数亲自跑一遍「规则五元组匹配 + 数值一步后验」。
  2026-09-24 从 ``plan_feasibility`` 改名（诞生时挂在 04 生成方案作预判）；落库键与配置键沿用旧名，
  见模块文档「归属与名字」。
  三点与包内其它模块不同，用之前先看清楚：

  1. **它不是叶子。** ``match_rule_row`` 会读 settings 与规则库 CSV，带文件 IO ——
     这是包里第一个这样的模块（``convergence`` 是纯叶子）。白名单放行 ``services.compliance``，
     **没有任何用例会替你提醒**。它因此切成「纯函数本体 + 带 IO 的外层」两层。
  2. **依赖方向是 ``rule_assessment → verdict``**（要 ``RuleRow`` / ``StepBasis``），
     与 ``convergence`` 相反（那边是 ``verdict → convergence``）。别照 convergence 的样子搬。
  3. **与 ``action_facts`` 名字上都讲锚点/步长/候选，区别在角色**：那个**转写**决策行上的
     既成事实（``plan_table.rule_basis`` 取出的一步依据），这个在决策行还不存在时**亲自算**。
     模块文档第一段就是这张对照表。

  它只给行级结论、不碰库不碰控制流；07 调整方案（``chain``）、落进决策行的规则依据
  （``new_chain.rule``）都是调用方拿它的结论做的事。
* :mod:`~services.decision.candidate_set` —— **决策步 04 生成方案的产出**：
  ``CandidateSet`` / ``CandidateGroup`` / ``CandidatePlan`` / ``Candidate``
  （方案组 → 方案 → 参数三层，2026-09-21 业务回话 Q1；「包」的命名已按业务
  口径作废）。**主键是方案组，分组键组名为主、组号为辅**（Q6 数据结论：
  组名 374/374 有值，组号整单缺失 9 单）。**不带档位**：初案 ``final_ratio`` 2026-09-24
  起业务定为无意义、不得用于方案决策，组按首现次序（ICOS 推送先后）列出，选择只按组。
  ``group_plans_by_group`` 是分组的唯一实现。
  纯函数、无 IO（可行性预判与关联判定都由调用方注入 callable，那个带文件 IO / LLM）。

* :mod:`~services.decision.relevance` —— **决策步 04 组内寻优**（差额清单 ②）：
  「方案与根因的关联性」判定的**契约 + 纯函数助手**。判据今天卡 P1.5 映射表，
  2026-09-22 起以两段式落地 —— Phase-1 LLM 载体（只注记、不动 dispatch，同
  ``rule_assessment`` 当年的 annotate 边界）、Phase-2 换映射表实现（``candidate_set``
  一行不动，挂 P6 双跑）。硬约束：**不许排序**（输出是最关联方案集合，不是评分）、
  **bypass = 组内全保留**（fail-open，只窄化不扩展）。LLM 调用本体由调用方注入的
  ``relevance_of`` callable 承载，本模块和 ``candidate_set`` 都不 import 提示词/模型。

* :mod:`~services.decision.cause_alignment` —— **决策步 05 根因对齐**（2026-10-03 业务）：模型以网优专家
  身份判 02 收敛根因与每个方案的对应关系（针对哪几条根因 / 通用收益 / 无关），四档由代码按「针对的根因里
  有没有主因」定；模型判「不一致」的方案不发（``chain.drop_by_alignment``，不剔到零，业务 10-03）。
  模型没判到 / 失败的方案按初案原因对上、只注记（``root_cause.converged_cause_match``），
  02 模型收敛没有根因时不调，调用方退回 :mod:`~services.decision.alignment` 的类别四档。

* :mod:`~services.decision.arbitration` —— **决策步 08 综合决策的参数冲突剔除**：
  同一参数在同一批里有两个以上不同目标值且都判了可下发 → 冲突各方全部剔除、该参数本轮
  保持现网值（业务 Q4「不择优」；2026-09-23 至 09-24 曾按 ``final_ratio`` 留最高分一方，
  该列被业务定为无意义后删掉）。本包**第三处**自己
  下判断的地方，理由是整批原子推送下「后写覆盖先写」不可预期。「怎样算冲突」走
  ``candidate_set.iter_value_conflicts`` 一处口径。
  纯函数，只给结论；改 ``need_call`` / 写 phase / 挂轨迹是 ``DecisionService`` 的事。

* :mod:`~services.decision.risk` —— **决策步 07 参数风险评估的确定性部分**：每个动作的
  风险**依据档**（硬约束内 / 余量不足一步 / 有规则无硬约束 / 规则库无匹配）与本轮下发
  集合的风险面。**不是新判断**，只归档：准入态取自 ``plan_table.verdict_row_state``，
  规则事实与余量取自 ``verdict.RuleRow`` / ``StepBasis``。风险**等级**等业务供
  ``parameter_level``（原样透传）；本轮 annotate，只落轨迹、不改下场。

* :mod:`~services.decision.gate` —— **决策步 08「是否满足决策条件」逐条评估（observe）**，
  也持有 **05 根因对齐的路由**（四档 → 专项 / 通用路径，注记）。条件：硬约束（实际下发值
  用代码事实复核）/ 一致性·同参数多值 / 一致性·功能互斥（未评估）/ 风险·余量（只注记，
  记未评估）/ 风险·分级（未评估）；通用方案容忍度（待拍板 #2）2026-09-24 拍板「通用不比专项更严」已删。
  三态 passed / failed / not_evaluated，
  **未评估不是通过**。只落轨迹、不改下场；``to_gate_result`` 落成 ``OrderDecision.gate``
  的既有类型，供对象转正时直接用。

* :mod:`~services.decision.chain` —— **决策链**（2026-09-25 合规链删除后唯一的裁决链）：从候选集整条算 ——
  04 每个方案组按与根因的关联性寻优、并列都留；05 剔除与收敛根因不一致的方案（不剔到零）；
  07 读参数规则库（``rule_assessment`` 的确定性结论，调用方算好传入）对方案调整：
  按 ``rule_scope`` 改写为一步，不满足 ``para`` 取值约束等四档剔除，无规则照发（条件下发）；
  08 与 ``arbitration`` 同一规则剔除同参数冲突；决策条件不满足按分支调优 / 剔除回环；06 整单复核的剔除也在这里做。
  结论落 ``OrderDecision.chain``（``decision_json.chain``，schema ≤ 13 的存量对象里叫 ``shadow``），
  ``DecisionService`` 把它写进决策行。纯函数。
  四步各是一个函数（``select_plans`` → ``assess_rules`` → ``drop_conflicts`` → ``resolve_conditions``，
  读写同一份 ``ChainState``），流水线逐步调用、逐步记轨迹；``run_chain`` 是它们的组合入口。

* :mod:`~services.decision.pipeline` —— **决策流水线的机制**：``Stage``（步骤编号 / 名字 / 职责 / 失败口径）、
  ``Pipeline``（按序执行、条件跳过、``PipelineExit`` 退出）、``StageRecord``（每一步的轨迹，落
  ``OrderDecision.pipeline``）。只有机制、不含业务步骤；业务流程本身是 ``services.orders.decision_service``
  的 ``DECISION_PIPELINE`` 那张表 —— 读它就是读流程图。叶子模块，谁都能依赖。

* :mod:`~services.decision.phase` —— 决策行 ``llm_solution.phase`` 的词表。新行只有
  ``new_chain`` 与多轮决策几档；合规链时期的取值整份保留，给老轮次读。

表不在这里
----------
本包只出事实与计数。六段正文表（方案组汇总 / 生成方案 / 根因收敛 / 裁决依据 / 参数编排 /
最终参数方案）的表头、单元格转义、表后总结句，以及「根因候选」面板的展示字段（Tailwind
``tone`` / ``confidenceLabel`` / ``dimension`` / ``evidence``）都在
``services/frontend_view/decision_render.py``（P5「渲染迁出决策包」，2026-09-23，产出逐字不变）。
``tests/test_decision_package.py`` 钉住本包里没有单元格转义表与 Tailwind 类名。
"""
