"""把 memory_objects / state_transitions / memory_scores 打包为 Memory Package。

布局：
    memory_package/exports/<pkg_id>/
        manifest.json
        memory_objects.jsonl
        state_transitions.jsonl
        memory_scores.jsonl
        evidence_units.jsonl   (可选)
        memory_evidence_profiles.jsonl
        support_routing_profiles.jsonl
        state_transition_manifest.json
        index.json             (issue_type → memory_ids)
        README.md
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

from ..common import io as cio
from ..common import paths as P
from ..common.schema_check import validate


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _is_veto_pool_memory(memory: dict) -> bool:
    memory_type = memory.get("memory_type")
    state = memory.get("state")
    if memory_type == "counter_evidence_memory":
        return True
    return memory_type in {"strategy_memory", "playbook_memory"} and state == "counter_evidence"


def _stats(memories: list[dict], scores: list[dict]) -> dict:
    type_counter = Counter(m["memory_type"] for m in memories)
    state_counter = Counter(m["state"] for m in memories)
    avg_overall = sum(s["overall"] for s in scores) / max(1, len(scores))
    return {
        "case_memory_count": type_counter.get("case_memory", 0),
        "rca_memory_count": type_counter.get("rca_memory", 0),
        "strategy_memory_count": type_counter.get("strategy_memory", 0),
        "playbook_memory_count": type_counter.get("playbook_memory", 0),
        "risk_memory_count": type_counter.get("risk_memory", 0),
        "counter_evidence_count": type_counter.get("counter_evidence_memory", 0),
        "veto_pool_count": sum(1 for m in memories if _is_veto_pool_memory(m)),
        "validated_count": state_counter.get("validated", 0),
        "reusable_count": state_counter.get("reusable", 0),
        "restricted_count": state_counter.get("restricted", 0),
        "counter_evidence_state_count": state_counter.get("counter_evidence", 0),
        "deprecated_count": state_counter.get("deprecated", 0),
        "average_overall_score": round(avg_overall, 4),
    }


def _episode_stats(candidates: list[dict], episodes_by_id: dict) -> dict:
    return {
        "case_episode_candidate_count": len(candidates),
        "case_episode_semantic_count": sum(
            1 for c in candidates if c.get("episode_id") in episodes_by_id
        ),
    }


def _strategy_sample_stats(sample_links: list[dict], samples: list[dict], sample_episodes: list[dict]) -> dict:
    return {
        "strategy_sample_link_count": len(sample_links),
        "strategy_sample_episode_count": len(sample_episodes),
        "strategy_sample_count": len(samples),
        "strategy_sample_representative_count": sum(1 for row in samples if row.get("is_representative")),
        "strategy_sample_episode_representative_count": sum(
            len(row.get("representative_sample_ids") or []) for row in sample_episodes
        ),
    }


def _memory_evidence_profile_stats(profiles: list[dict], transition_manifest: dict | None) -> dict:
    profile_types = Counter(row.get("profile_type") for row in profiles)
    out = {
        "memory_evidence_profile_count": len(profiles),
        "support_profile_count": profile_types.get("support_profile", 0),
        "counter_profile_count": profile_types.get("counter_profile", 0),
        "conflict_profile_count": profile_types.get("conflict_profile", 0),
        "sparse_profile_count": profile_types.get("sparse_profile", 0),
    }
    if transition_manifest:
        out["hierarchical_refinement_child_count"] = sum(
            transition_manifest.get("hierarchical_refinement_child_distribution", {}).values()
        )
    return out


def _support_routing_profile_stats(profiles: list[dict]) -> dict:
    profile_sets = Counter(row.get("profile_set_id") for row in profiles)
    return {
        "support_routing_profile_count": len(profiles),
        "support_routing_profile_sets": dict(profile_sets),
    }


def _to_int(value: object, default: int = 0) -> int:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _routing_profile_from_embedded_support(profile: dict) -> dict | None:
    profile_key = profile.get("profile_key")
    if not isinstance(profile_key, list) or len(profile_key) < 2:
        return None
    key_family = str(profile.get("profile_family") or profile_key[0] or "").strip()
    key_values = [str(value) for value in profile_key[1:] if str(value or "").strip()]
    if not key_family or len(key_values) != len(profile_key[1:]):
        return None

    quality = profile.get("quality") if isinstance(profile.get("quality"), dict) else {}
    support_count = _to_int(quality.get("support_count"), _to_int(profile.get("trace_count")))
    fail_count = _to_int(quality.get("long_eval_fail_count"))
    pass_count = _to_int(quality.get("long_eval_pass_count"), max(0, support_count - fail_count))
    fail_rate = _to_float(
        quality.get("fail_rate"),
        round(fail_count / support_count, 6) if support_count else 0.0,
    )
    pass_rate = _to_float(
        quality.get("pass_rate"),
        round(pass_count / support_count, 6) if support_count else 0.0,
    )
    pass_lcb = _to_float(quality.get("pass_credibility_lcb"))
    fallback_id = hashlib.sha256("|".join([key_family, *key_values]).encode()).hexdigest()[:16]
    profile_id = str(profile.get("profile_id") or fallback_id)
    return {
        "profile_id": profile_id,
        "profile_set_id": "hard_zero_fail_specific_v1",
        "profile_set_label": "Embedded hard zero-fail support profiles（嵌入式硬零失败正向画像）",
        "key_family": key_family,
        "key_values": key_values,
        "support_count": support_count,
        "pass_count": pass_count,
        "fail_count": fail_count,
        "pass_rate": round(pass_rate, 6),
        "fail_rate": round(fail_rate, 6),
        "pass_lcb": round(pass_lcb, 6),
        "fail_lcb": 0.0,
        "fail_ucb": 0.0,
        "intended_use": "runtime support/counter arbitration; release only with low counter prior",
        "selection_config": profile.get("selection_policy") or {},
        "source": "embedded_memory_support_profiles",
    }


def _embedded_support_profiles(memory: dict) -> list[dict]:
    content = memory.get("content") if isinstance(memory.get("content"), dict) else {}
    out = []
    profiles = content.get("support_profiles")
    if isinstance(profiles, list):
        out.extend(profile for profile in profiles if isinstance(profile, dict))
    components = content.get("components")
    if isinstance(components, list):
        for component in components:
            if not isinstance(component, dict):
                continue
            component_profiles = component.get("support_profiles")
            if isinstance(component_profiles, list):
                out.extend(profile for profile in component_profiles if isinstance(profile, dict))
    return out


def _derive_support_routing_profiles(memories: list[dict]) -> list[dict]:
    dedup: dict[tuple[str, tuple[str, ...], str], dict] = {}
    for memory in memories:
        for support_profile in _embedded_support_profiles(memory):
            routing_profile = _routing_profile_from_embedded_support(support_profile)
            if not routing_profile:
                continue
            key = (
                str(routing_profile.get("key_family") or ""),
                tuple(routing_profile.get("key_values") or []),
                str(routing_profile.get("profile_id") or ""),
            )
            prev = dedup.get(key)
            if prev is None or (
                _to_float(routing_profile.get("pass_lcb")),
                _to_int(routing_profile.get("support_count")),
            ) > (
                _to_float(prev.get("pass_lcb")),
                _to_int(prev.get("support_count")),
            ):
                dedup[key] = routing_profile
    return sorted(
        dedup.values(),
        key=lambda row: (
            str(row.get("profile_set_id") or ""),
            str(row.get("key_family") or ""),
            tuple(row.get("key_values") or []),
            str(row.get("profile_id") or ""),
        ),
    )


def _build_episodes_index(
    candidates: list[dict],
    episodes_by_id: dict[str, dict],
) -> dict:
    entries = []
    for cand in candidates:
        eid = cand.get("episode_id")
        if not eid:
            continue
        has_semantic = eid in episodes_by_id
        entries.append({
            "episode_id": eid,
            "candidate_id": eid,
            "has_semantic": has_semantic,
            "load_policy": "with_candidate_only",
            "layers": ["episode_rules", "semantic"] if has_semantic else ["episode_rules"],
        })
    return {
        "bind_key": "episode_id",
        "semantic_requires_candidate": True,
        "entries": entries,
    }


def _knowledge_layers() -> list[dict]:
    return [
        {
            "layer": "executable",
            "description": "可执行策略/组合/根因",
            "file": "memory_objects.jsonl",
            "memory_types": ["strategy_memory", "playbook_memory", "rca_memory"],
        },
        {
            "layer": "veto",
            "description": "在线否决池",
            "file": "memory_objects.jsonl",
            "filter": "veto_pool",
        },
        {
            "layer": "trace_index",
            "description": "工单快照索引",
            "file": "memory_objects.jsonl",
            "memory_types": ["case_memory"],
        },
        {
            "layer": "memory_evidence_profiles",
            "description": "support/counter/conflict/sparse 运行态证据画像与建议分流",
            "file": "memory_evidence_profiles.jsonl",
            "manifest_file": "state_transition_manifest.json",
            "bind_to": "memory_objects.jsonl",
            "bind_key": "parent_memory_id",
            "load_policy": "profile_manifest_then_parent_memory",
        },
        {
            "layer": "support_routing_profiles",
            "description": "R13b 正向支持画像路由 sidecar；运行态需再结合反证 prior 才能释放 review",
            "file": "support_routing_profiles.jsonl",
            "bind_to": "memory_objects.jsonl",
            "bind_key": "profile_key",
            "load_policy": "support_profile_then_counter_prior_arbitration",
        },
        {
            "layer": "strategy_samples",
            "description": "策略、组合方案与反证/否决对象静态挂接的去重工单样本索引",
            "file": "strategy_sample_links.jsonl",
            "episode_file": "strategy_sample_episodes.jsonl",
            "detail_file": "strategy_samples.jsonl",
            "bind_to": "memory_objects.jsonl",
            "bind_key": "memory_id",
            "load_policy": "aggregate_episode_representative_then_paged_raw",
        },
        {
            "layer": "episode_rules",
            "description": "案例 episode 规则骨架",
            "file": "case_episode_candidates.jsonl",
        },
        {
            "layer": "semantic",
            "description": "案例 episode LLM 语义层",
            "file": "case_episodes.jsonl",
            "bind_to": "case_episode_candidates.jsonl",
            "bind_key": "episode_id",
            "load_policy": "with_candidate_only",
        },
    ]


def _build_index(memories: list[dict]) -> dict:
    issue_idx: dict[str, list[str]] = defaultdict(list)
    state_idx: dict[str, list[str]] = defaultdict(list)
    type_idx: dict[str, list[str]] = defaultdict(list)
    for m in memories:
        for it in m.get("applicability", {}).get("issue_types", []):
            issue_idx[it].append(m["memory_id"])
        state_idx[m["state"]].append(m["memory_id"])
        type_idx[m["memory_type"]].append(m["memory_id"])
    return {
        "by_issue_type": dict(issue_idx),
        "by_state": dict(state_idx),
        "by_type": dict(type_idx),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--memories", default=str(P.MEMORY_OBJECTS_JSONL))
    ap.add_argument("--transitions", default=str(P.STATE_TRANSITIONS_JSONL))
    ap.add_argument("--scores", default=str(P.MEMORY_SCORES_JSONL))
    ap.add_argument("--evidence", default=str(P.EVIDENCE_UNITS_JSONL))
    ap.add_argument("--name", default="cold_start_v1")
    ap.add_argument("--compile-backend", default="rule_v1", choices=["rule_v1", "llm_v1", "hybrid_v1"])
    ap.add_argument(
        "--compile-eligibility",
        default="enabled",
        choices=["enabled", "disabled"],
        help="记录生成本包时效果学习池准入是否启用",
    )
    ap.add_argument(
        "--counter-evidence-config",
        default="",
        help="可选：记录本包使用的否决池构建阈值 profile JSON",
    )
    ap.add_argument("--sample-size", type=int, default=0)
    ap.add_argument("--also-sample", action="store_true",
                    help="同时复制到 memory_package/sample/ 作为 git 入库样例")
    ap.add_argument("--dataset", default="shanxi_2026", help="manifest.source.dataset")
    ap.add_argument("--episode-candidates", default=str(P.CASE_EPISODE_CANDIDATES_JSONL))
    ap.add_argument("--episodes", default=str(P.CASE_EPISODES_JSONL))
    ap.add_argument("--strategy-sample-links", default=str(P.STRATEGY_SAMPLE_LINKS_JSONL))
    ap.add_argument("--strategy-samples", default=str(P.STRATEGY_SAMPLES_JSONL))
    ap.add_argument("--strategy-sample-episodes", default=str(P.STRATEGY_SAMPLE_EPISODES_JSONL))
    ap.add_argument("--memory-evidence-profiles", default=str(P.MEMORY_EVIDENCE_PROFILES_JSONL))
    ap.add_argument("--support-routing-profiles", default=str(P.SUPPORT_ROUTING_PROFILES_JSONL))
    ap.add_argument("--plan-certification-action-risk-profiles", default="")
    ap.add_argument("--plan-certification-bundle-risk-profiles", default="")
    ap.add_argument("--state-transition-manifest", default=str(P.STATE_TRANSITION_MANIFEST_JSON))
    ap.add_argument("--eval-split", default=str(P.EVAL_SPLIT_JSON),
                    help="可选 eval_split.json，写入 manifest.source.eval_split_id")
    args = ap.parse_args()

    P.ensure_dirs()
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    pkg_id = f"{args.name}_{timestamp}"
    pkg_dir = P.MEMORY_PKG_EXPORTS / pkg_id
    pkg_dir.mkdir(parents=True, exist_ok=True)

    memories = list(cio.read_jsonl(args.memories))
    scores = list(cio.read_jsonl(args.scores))
    transitions = list(cio.read_jsonl(args.transitions))
    evidence = list(cio.read_jsonl(args.evidence))

    # 限制 evidence 输出大小：只导出 memories.evidence_ids 命中的 evidence
    needed_ev_ids = set()
    for m in memories:
        for eid in m.get("evidence_ids", []):
            needed_ev_ids.add(eid)
    evidence_filtered = [e for e in evidence if e["evidence_id"] in needed_ev_ids]

    # 写包内文件
    cio.write_jsonl(pkg_dir / "memory_objects.jsonl", memories)
    cio.write_jsonl(pkg_dir / "memory_scores.jsonl", scores)
    cio.write_jsonl(pkg_dir / "state_transitions.jsonl", transitions)
    cio.write_jsonl(pkg_dir / "evidence_units.jsonl", evidence_filtered)

    index = _build_index(memories)
    (pkg_dir / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")

    episode_candidates = list(cio.read_jsonl(args.episode_candidates)) if Path(args.episode_candidates).exists() else []
    case_episodes = list(cio.read_jsonl(args.episodes)) if Path(args.episodes).exists() else []
    episodes_by_id = {e.get("episode_id"): e for e in case_episodes if e.get("episode_id")}
    if episode_candidates:
        cio.write_jsonl(pkg_dir / "case_episode_candidates.jsonl", episode_candidates)
    if case_episodes:
        cio.write_jsonl(pkg_dir / "case_episodes.jsonl", case_episodes)
    episodes_index = _build_episodes_index(episode_candidates, episodes_by_id)
    (pkg_dir / "episodes_index.json").write_text(
        json.dumps(episodes_index, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    strategy_sample_links = list(cio.read_jsonl(args.strategy_sample_links)) if Path(args.strategy_sample_links).exists() else []
    strategy_samples = list(cio.read_jsonl(args.strategy_samples)) if Path(args.strategy_samples).exists() else []
    strategy_sample_episodes = (
        list(cio.read_jsonl(args.strategy_sample_episodes))
        if Path(args.strategy_sample_episodes).exists()
        else []
    )
    if strategy_sample_links:
        cio.write_jsonl(pkg_dir / "strategy_sample_links.jsonl", strategy_sample_links)
    if strategy_sample_episodes:
        cio.write_jsonl(pkg_dir / "strategy_sample_episodes.jsonl", strategy_sample_episodes)
    if strategy_samples:
        cio.write_jsonl(pkg_dir / "strategy_samples.jsonl", strategy_samples)

    memory_evidence_profiles = (
        list(cio.read_jsonl(args.memory_evidence_profiles))
        if Path(args.memory_evidence_profiles).exists()
        else []
    )
    state_transition_manifest = None
    state_transition_manifest_path = Path(args.state_transition_manifest)
    if state_transition_manifest_path.exists():
        state_transition_manifest = json.loads(state_transition_manifest_path.read_text(encoding="utf-8"))
    if memory_evidence_profiles:
        cio.write_jsonl(pkg_dir / "memory_evidence_profiles.jsonl", memory_evidence_profiles)
    if state_transition_manifest:
        (pkg_dir / "state_transition_manifest.json").write_text(
            json.dumps(state_transition_manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    support_routing_profiles = (
        list(cio.read_jsonl(args.support_routing_profiles))
        if Path(args.support_routing_profiles).exists()
        else _derive_support_routing_profiles(memories)
    )
    if support_routing_profiles:
        cio.write_jsonl(pkg_dir / "support_routing_profiles.jsonl", support_routing_profiles)
    plan_certification_action_risk_profiles = (
        list(cio.read_jsonl(args.plan_certification_action_risk_profiles))
        if args.plan_certification_action_risk_profiles and Path(args.plan_certification_action_risk_profiles).exists()
        else []
    )
    if plan_certification_action_risk_profiles:
        cio.write_jsonl(
            pkg_dir / "plan_certification_action_risk_profiles.jsonl",
            plan_certification_action_risk_profiles,
        )
    plan_certification_bundle_risk_profiles = (
        list(cio.read_jsonl(args.plan_certification_bundle_risk_profiles))
        if args.plan_certification_bundle_risk_profiles and Path(args.plan_certification_bundle_risk_profiles).exists()
        else []
    )
    if plan_certification_bundle_risk_profiles:
        cio.write_jsonl(
            pkg_dir / "plan_certification_bundle_risk_profiles.jsonl",
            plan_certification_bundle_risk_profiles,
        )

    trace_ids = sorted({tid for m in memories for tid in m.get("trace_ids", [])})
    counter_evidence_config = None
    counter_evidence_config_path = Path(args.counter_evidence_config) if args.counter_evidence_config else None
    if counter_evidence_config_path and counter_evidence_config_path.exists():
        counter_evidence_config = json.loads(counter_evidence_config_path.read_text(encoding="utf-8"))

    eval_split_id = None
    eval_split_path = Path(args.eval_split)
    if eval_split_path.exists():
        eval_split_id = json.loads(eval_split_path.read_text(encoding="utf-8")).get("split_id")

    manifest = {
        "package_id": pkg_id,
        "package_name": args.name,
        "version": "0.1",
        "description": "无线网络优化闭环 trace 离线知识编译冷启动 demo 输出",
        "source": {
            "dataset": args.dataset,
            "trace_count": len(trace_ids),
            "sampled": True,
            "sampling_strategy": "issue_type × ticket_outcome 分层抽样",
            "compile_backend": args.compile_backend,
            "compile_eligibility": args.compile_eligibility,
            **({"counter_evidence_config": counter_evidence_config} if counter_evidence_config else {}),
            **({"eval_split_id": eval_split_id} if eval_split_id else {}),
        },
        "knowledge_layers": _knowledge_layers() + ([{
            "layer": "plan_certification_action_risk_profiles",
            "description": "single-action attribution-safe calibrated risk profiles for bundle certification",
            "file": "plan_certification_action_risk_profiles.jsonl",
            "load_policy": "specific_exact_then_core; broad_prior_never_hard_route",
        }] if plan_certification_action_risk_profiles else []) + ([{
            "layer": "plan_certification_bundle_risk_profiles",
            "description": "executed-plan-bundle calibrated risk profiles; no component attribution",
            "file": "plan_certification_bundle_risk_profiles.jsonl",
            "load_policy": "exact_then_context_shape_then_shape",
        }] if plan_certification_bundle_risk_profiles else []),
        "stats": {
            **_stats(memories, scores),
            **_episode_stats(episode_candidates, episodes_by_id),
            **_strategy_sample_stats(strategy_sample_links, strategy_samples, strategy_sample_episodes),
            **_memory_evidence_profile_stats(memory_evidence_profiles, state_transition_manifest),
            **_support_routing_profile_stats(support_routing_profiles),
            "plan_certification_action_risk_profile_count": len(plan_certification_action_risk_profiles),
            "plan_certification_bundle_risk_profile_count": len(plan_certification_bundle_risk_profiles),
        },
        "files": {
            "memory_objects": "memory_objects.jsonl",
            "state_transitions": "state_transitions.jsonl",
            "memory_scores": "memory_scores.jsonl",
            "evidence_units": "evidence_units.jsonl",
            "index": "index.json",
            **({"memory_evidence_profiles": "memory_evidence_profiles.jsonl"} if memory_evidence_profiles else {}),
            **({"support_routing_profiles": "support_routing_profiles.jsonl"} if support_routing_profiles else {}),
            **({"plan_certification_action_risk_profiles": "plan_certification_action_risk_profiles.jsonl"} if plan_certification_action_risk_profiles else {}),
            **({"plan_certification_bundle_risk_profiles": "plan_certification_bundle_risk_profiles.jsonl"} if plan_certification_bundle_risk_profiles else {}),
            **({"state_transition_manifest": "state_transition_manifest.json"} if state_transition_manifest else {}),
            **({"case_episode_candidates": "case_episode_candidates.jsonl"} if episode_candidates else {}),
            **({"case_episodes": "case_episodes.jsonl"} if case_episodes else {}),
            **({"episodes_index": "episodes_index.json"} if episode_candidates else {}),
            **({"strategy_sample_links": "strategy_sample_links.jsonl"} if strategy_sample_links else {}),
            **({"strategy_sample_episodes": "strategy_sample_episodes.jsonl"} if strategy_sample_episodes else {}),
            **({"strategy_samples": "strategy_samples.jsonl"} if strategy_samples else {}),
        },
        "applicability_index": {k: len(v) for k, v in index["by_issue_type"].items()},
        "created_at": cio.now_iso(),
        "checksum": {"algo": "sha256", "manifest_excluded": True, "values": {}},
    }
    # 计算 checksum（不含 manifest 自身）
    checksum_files = [
        "memory_objects.jsonl",
        "state_transitions.jsonl",
        "memory_scores.jsonl",
        "evidence_units.jsonl",
        "index.json",
        "case_episode_candidates.jsonl",
        "case_episodes.jsonl",
        "episodes_index.json",
        "memory_evidence_profiles.jsonl",
        "support_routing_profiles.jsonl",
        "plan_certification_action_risk_profiles.jsonl",
        "plan_certification_bundle_risk_profiles.jsonl",
        "state_transition_manifest.json",
        "strategy_sample_links.jsonl",
        "strategy_sample_episodes.jsonl",
        "strategy_samples.jsonl",
    ]
    for fname in checksum_files:
        fpath = pkg_dir / fname
        if fpath.exists():
            manifest["checksum"]["values"][fname] = _sha256(fpath)

    errs = validate(manifest, "memory_package")
    if errs:
        print(f"[package] manifest schema errors: {errs[:5]}", file=sys.stderr)

    (pkg_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # README
    readme = _render_readme(manifest)
    (pkg_dir / "README.md").write_text(readme, encoding="utf-8")

    print(f"[package] DONE: {pkg_dir}", file=sys.stderr)

    if args.also_sample:
        sample_target = P.MEMORY_PKG_SAMPLE / args.name
        if sample_target.exists():
            shutil.rmtree(sample_target)
        shutil.copytree(pkg_dir, sample_target)
        print(f"[package] also copied to {sample_target}", file=sys.stderr)


def _render_readme(manifest: dict) -> str:
    s = manifest["stats"]
    lines = []
    lines.append(f"# Memory Package: {manifest['package_id']}")
    lines.append("")
    lines.append(f"- dataset: `{manifest['source']['dataset']}`")
    lines.append(f"- compile backend: `{manifest['source']['compile_backend']}`")
    lines.append(f"- trace count: {manifest['source']['trace_count']}")
    lines.append(f"- created at: {manifest['created_at']}")
    lines.append("")
    lines.append("## stats")
    lines.append("")
    for k, v in s.items():
        lines.append(f"- {k}: {v}")
    lines.append("")
    lines.append("## files")
    for k, v in manifest["files"].items():
        lines.append(f"- {k}: `{v}`")
    return "\n".join(lines)


if __name__ == "__main__":
    main()
