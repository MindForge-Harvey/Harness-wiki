"""统一路径常量。任何 pipeline 文件都通过这里拿绝对路径，避免工作目录歧义。"""

from __future__ import annotations

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]

# 工程开发记忆侧
DOCS = PROJECT_ROOT / "docs"
SCHEMAS = PROJECT_ROOT / "schemas"
PROMPTS = PROJECT_ROOT / "prompts"
SKILLS_DIR = PROJECT_ROOT  # 当前 skill 都以 wireless-*/SKILL.md 形式直接落在仓库根

# 运行态运维记忆侧（git ignore）
DATA = PROJECT_ROOT / "data"
DATA_RAW = DATA / "raw"
DATA_RAW_SOURCE = DATA_RAW / "source"  # 实验切分主库原始文件；不直接作为 train/dev/holdout
DATA_RAW_ACTION_ONTOLOGY = DATA_RAW / "action_ontology"  # 团队共享的 action normalization 输入产物
DATA_RAW_TRAIN = DATA_RAW / "train"  # 旧训练覆盖目录；ingest 仍兼容这里的 xlsx/csv
DATA_RAW_EVAL = DATA_RAW / "eval"    # 评测集 A / 影子工作台 / 外部 hold-out
DATA_RAW_TRAIN_CSV = DATA_RAW / "train.csv"
DATA_RAW_DEV_CSV = DATA_RAW / "dev.csv"
DATA_RAW_HOLDOUT_CSV = DATA_RAW / "holdout.csv"
DATA_RAW_SPLIT_MANIFEST = DATA_RAW / "manifest.json"
TEST_XLSX = DATA_RAW / "test.xlsx"   # 旧的单文件评测路径（保留兼容；优先用 DATA_RAW_EVAL/）
DATA_STAGED = DATA / "staged"
DATA_STAGED_SPLITS = DATA_STAGED / "splits"
DATA_COMPILED = DATA / "compiled"
DATA_SAMPLES = DATA / "samples"
# Publication-artifact runs must not write generated packages into the source
# tree. Keep all reconstructed packages below the ignored runs/ boundary.
MEMORY_PKG = PROJECT_ROOT / "runs" / "memory_package"
MEMORY_PKG_EXPORTS = MEMORY_PKG / "exports"
MEMORY_PKG_SAMPLE = MEMORY_PKG / "sample"
RUNTIME_MEMORY = PROJECT_ROOT / "runtime_memory"


def ensure_dirs():
    for p in [
        DATA_RAW,
        DATA_RAW_SOURCE,
        DATA_RAW_ACTION_ONTOLOGY,
        DATA_STAGED,
        DATA_STAGED_SPLITS,
        DATA_COMPILED,
        DATA_SAMPLES,
        MEMORY_PKG_EXPORTS,
        MEMORY_PKG_SAMPLE,
        RUNTIME_MEMORY,
    ]:
        p.mkdir(parents=True, exist_ok=True)


SUPPORTED_RAW_INPUT_SUFFIXES = (".csv", ".xlsx")


def _scan_raw_inputs(directory: Path) -> list[Path]:
    files: list[Path] = []
    if not directory.exists():
        return files
    for suffix in SUPPORTED_RAW_INPUT_SUFFIXES:
        files.extend(path for path in directory.glob(f"*{suffix}") if path.is_file())
    return sorted(files)


def resolve_train_inputs(explicit: str | None = None) -> list["Path"]:
    """Resolve ingest training input(s).

    Priority:
      1) explicit path provided by user (file or directory)
      2) fixed final split file data/raw/train.csv
      3) legacy data/raw/train/*.{csv,xlsx}
      4) data/raw/source/*.{csv,xlsx} when train inputs are empty

    Returns a sorted list of file paths (deterministic). Empty list if nothing found.
    """
    from pathlib import Path

    if explicit:
        p = Path(explicit)
        if p.is_dir():
            return _scan_raw_inputs(p)
        if p.is_file() and p.suffix.lower() in SUPPORTED_RAW_INPUT_SUFFIXES:
            return [p]
        return []

    if DATA_RAW_TRAIN_CSV.exists():
        return [DATA_RAW_TRAIN_CSV]

    files = _scan_raw_inputs(DATA_RAW_TRAIN)
    if files:
        return files

    files = _scan_raw_inputs(DATA_RAW_SOURCE)
    if files:
        return files

    return []


def resolve_train_xlsx_inputs(explicit: str | None = None) -> list["Path"]:
    """Backward-compatible alias for callers that still use the old name.

    Despite the historical name, this now returns supported raw training inputs
    (`.csv` and `.xlsx`) so old commands can ingest the fixed CSV split.
    """
    return resolve_train_inputs(explicit)


def resolve_eval_xlsx_inputs(explicit: str | None = None) -> list["Path"]:
    """Resolve eval workbook input(s).

    Priority:
      1) explicit path (file or directory)
      2) data/raw/eval/*.xlsx
      3) legacy data/raw/test.xlsx
    """
    from pathlib import Path

    if explicit:
        p = Path(explicit)
        if p.is_dir():
            return sorted(p.glob("*.xlsx"))
        if p.is_file():
            return [p]
        return []

    if DATA_RAW_EVAL.exists():
        files = sorted(DATA_RAW_EVAL.glob("*.xlsx"))
        if files:
            return files

    if TEST_XLSX.exists():
        return [TEST_XLSX]
    return []


# 默认产物路径
TRACE_RECORDS_JSONL = DATA_STAGED / "trace_records.jsonl"
TRACE_RECORDS_ALL_JSONL = DATA_STAGED / "trace_records_all.jsonl"
TIME_SPLIT_JSON = DATA_STAGED_SPLITS / "main_time_split.json"
TRAIN_TRACE_RECORDS_JSONL = DATA_STAGED_SPLITS / "train_trace_records.jsonl"
DEV_TRACE_RECORDS_JSONL = DATA_STAGED_SPLITS / "dev_trace_records.jsonl"
HOLDOUT_TRACE_RECORDS_JSONL = DATA_STAGED_SPLITS / "holdout_trace_records.jsonl"
EVAL_TRACE_RECORDS_JSONL = DATA_STAGED / "eval_trace_records.jsonl"
EVIDENCE_UNITS_JSONL = DATA_COMPILED / "evidence_units.jsonl"
COMPILE_BATCH_JSONL = DATA_COMPILED / "compile_batch.jsonl"
MEMORY_OBJECTS_JSONL = DATA_COMPILED / "memory_objects.jsonl"
TRACE_TO_MEMORY_PIPELINE_MANIFEST_JSON = DATA_COMPILED / "trace_to_memory_pipeline_manifest.json"
ACTION_ONTOLOGY_REVIEWED_DRAFT_JSON = DATA_RAW_ACTION_ONTOLOGY / "action_ontology_reviewed_draft_v2.json"
ACTION_ONTOLOGY_SIGNATURE_POLICY_CSV = DATA_RAW_ACTION_ONTOLOGY / "action_ontology_signature_policy_v2.csv"
ACTION_ONTOLOGY_LINK_POLICY_CSV = DATA_RAW_ACTION_ONTOLOGY / "action_ontology_link_policy_v2.csv"
CASE_EPISODE_CANDIDATES_JSONL = DATA_COMPILED / "case_episode_candidates.jsonl"
CASE_EPISODES_JSONL = DATA_COMPILED / "case_episodes.jsonl"
CASE_EPISODES_V2_JSONL = DATA_COMPILED / "case_episodes_v2.jsonl"
CASE_EPISODE_LLM_RUNS_JSONL = DATA_COMPILED / "case_episode_llm_runs.jsonl"
STRATEGY_SAMPLE_LINKS_JSONL = DATA_COMPILED / "strategy_sample_links.jsonl"
STRATEGY_SAMPLES_JSONL = DATA_COMPILED / "strategy_samples.jsonl"
STRATEGY_SAMPLE_EPISODES_JSONL = DATA_COMPILED / "strategy_sample_episodes.jsonl"
SHADOW_NAVIGATION_MAP_JSON = DATA_COMPILED / "shadow_navigation_map.json"
STATE_TRANSITIONS_JSONL = DATA_COMPILED / "state_transitions.jsonl"
MEMORY_EVIDENCE_PROFILES_JSONL = DATA_COMPILED / "memory_evidence_profiles.jsonl"
SUPPORT_ROUTING_PROFILES_JSONL = DATA_COMPILED / "support_routing_profiles.jsonl"
STATE_TRANSITION_MANIFEST_JSON = DATA_COMPILED / "state_transition_manifest.json"
MEMORY_SCORES_JSONL = DATA_COMPILED / "memory_scores.jsonl"
EVAL_SPLIT_JSON = DATA_COMPILED / "eval_split.json"
EVAL_SET_A_JSONL = DATA_COMPILED / "eval_set_a.jsonl"
EVAL_SET_A_META_JSON = DATA_COMPILED / "eval_set_a_meta.json"
