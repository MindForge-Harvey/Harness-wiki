---
name: wireless-evidence-builder
description: 将用户提供的 KPI、MR、KQI、告警、参数或邻区材料按工单对象、窗口与口径对齐，构建有稳定 ID 的当前证据包，隔离冲突和缺失；用于根因分析前的取证整理。
---

方法继承源 `wireless-evidence-builder/SKILL.md` 的指标、参数、告警、MR/KQI/路测和邻区拓扑证据组织；来源见 [能力目录](../wireless-workorder-orchestrator/references/echo-capabilities.md)。普通分析直接整理本轮实际输入，无需先建工单。需要保存或已有工程工单时读 [观测输入契约](../wireless-workorder-orchestrator/references/input-contracts.md)，再用 `wireless_workorder(operation="build_evidence", workorder_id=..., input={observations, historical_case_ids})`。

只输入实际看到的观测及其 source_ref。KPI/MR/KQI 明确 metric、value、unit、definition、对象和带时区窗口；有分子/分母时保留，工具核对比例一致性。sample_count 是实际样本量，不从百分比倒推。不替用户发明 PRB/SINR 等告警门限；阈值须带判据来源。

工具按同对象、同工单窗口检查，返回 current_evidence、quarantined、duplicates。跨窗口的材料不能仅改写日期后塞入当前证据：先取得可比较窗口或作为待对齐背景解释。重复或冲突 ID 需要核对，隔离观测不得供根因引用。

历史案例 ID 从 `wireless_case_search` 取得，放 historical_case_ids；历史动作和整单 Pass 不转成当前 KPI。记录用户来源尚未核验的边界，将事实、声明阈值下异常、背景经验与未验证假设分别解释。

build_evidence 替换该工单的当前证据包，并使既有分型与诊断失效；补数时先 read，将仍有效的已有观测一并保留。证据不足则返回缺口，已对齐部分照常交付。
