#!/usr/bin/env python3
"""
OmniAgent CLI 评测集覆盖度验证脚本

用法：
    python3 coverage_check.py

验证两个评测集是否满足 spec 的覆盖要求：
1. risk-classifier/dataset.jsonl - Risk Classifier 评测集（≥100 条）
2. memory-recall/dataset.jsonl - findRelevantMemories 评测集（≥30 条）

退出码：
    0 = 全部通过
    1 = 有失败项
"""

import json
import os
import sys
from collections import Counter
from pathlib import Path

EVAL_DIR = Path(__file__).parent
RC_FILE = EVAL_DIR / "risk-classifier" / "dataset.jsonl"
RM_FILE = EVAL_DIR / "memory-recall" / "dataset.jsonl"

# 颜色输出
def green(s): return f"\033[32m{s}\033[0m"
def red(s): return f"\033[31m{s}\033[0m"
def yellow(s): return f"\033[33m{s}\033[0m"
def bold(s): return f"\033[1m{s}\033[0m"

class CheckResult:
    def __init__(self, name):
        self.name = name
        self.passed = []
        self.failed = []
        self.warnings = []

    def pass_(self, msg):
        self.passed.append(msg)

    def fail(self, msg):
        self.failed.append(msg)

    def warn(self, msg):
        self.warnings.append(msg)

    def is_ok(self):
        return len(self.failed) == 0

    def report(self):
        print(bold(f"\n=== {self.name} ==="))
        for m in self.passed:
            print(f"  {green('PASS')} {m}")
        for m in self.warnings:
            print(f"  {yellow('WARN')} {m}")
        for m in self.failed:
            print(f"  {red('FAIL')} {m}")
        status = green("OK") if self.is_ok() else red("FAIL")
        print(f"  -> {status}")


def load_jsonl(path):
    records = []
    with open(path) as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as e:
                print(f"  {red('INVALID JSON')} line {i} in {path}: {e}")
                return None
    return records


def check_risk_classifier():
    r = CheckResult("Risk Classifier 评测集")

    if not RC_FILE.exists():
        r.fail(f"文件不存在: {RC_FILE}")
        return r

    records = load_jsonl(RC_FILE)
    if records is None:
        r.fail("JSONL 解析失败")
        return r

    # 检查 1: 总数 ≥ 100
    if len(records) >= 100:
        r.pass_(f"总数 {len(records)} ≥ 100")
    else:
        r.fail(f"总数 {len(records)} < 100")

    # 检查 2: 字段完整性
    required_fields = ["id", "command", "label", "category", "confidence",
                       "context", "expected_decision", "expected_stage"]
    missing_field_records = []
    for rec in records:
        for f in required_fields:
            if f not in rec or not rec[f]:
                missing_field_records.append((rec.get("id", "?"), f))
    if not missing_field_records:
        r.pass_(f"所有 {len(required_fields)} 个必填字段完整")
    else:
        for id_, f in missing_field_records[:5]:
            r.fail(f"记录 {id_} 缺字段 {f}")
        if len(missing_field_records) > 5:
            r.fail(f"... 共 {len(missing_field_records)} 条缺字段")

    # 检查 3: label 取值
    valid_labels = {"safe", "dangerous"}
    labels = Counter(rec.get("label") for rec in records)
    invalid_labels = [l for l in labels if l not in valid_labels]
    if not invalid_labels:
        r.pass_(f"label 分布: {dict(labels)}")
    else:
        r.fail(f"非法 label: {invalid_labels}")

    # 检查 4: expected_decision 取值
    valid_decisions = {"allow", "deny", "ask"}
    decisions = Counter(rec.get("expected_decision") for rec in records)
    invalid_decisions = [d for d in decisions if d not in valid_decisions]
    if not invalid_decisions:
        r.pass_(f"expected_decision 分布: {dict(decisions)}")
    else:
        r.fail(f"非法 expected_decision: {invalid_decisions}")

    # 检查 5: expected_stage 取值
    valid_stages = {"fast", "thinking"}
    stages = Counter(rec.get("expected_stage") for rec in records)
    invalid_stages = [s for s in stages if s not in valid_stages]
    if not invalid_stages:
        r.pass_(f"expected_stage 分布: {dict(stages)}")
    else:
        r.fail(f"非法 expected_stage: {invalid_stages}")

    # 检查 6: 一致性 label vs expected_decision
    inconsistent = []
    for rec in records:
        label = rec.get("label")
        decision = rec.get("expected_decision")
        if label == "safe" and decision not in ("allow", "ask"):
            inconsistent.append((rec.get("id"), f"safe 但 decision={decision}"))
        elif label == "dangerous" and decision not in ("deny", "ask"):
            inconsistent.append((rec.get("id"), f"dangerous 但 decision={decision}"))
    if not inconsistent:
        r.pass_("label 与 expected_decision 一致")
    else:
        for id_, msg in inconsistent[:5]:
            r.fail(f"记录 {id_}: {msg}")

    # 检查 7: 类别覆盖
    categories = Counter(rec.get("category", "").split("-")[0] for rec in records)
    required_c = [f"C{i:02d}" for i in range(1, 25)]
    required_r = [f"R{i:02d}" for i in range(1, 6)]
    required_b = ["B01", "B02"]
    all_required = required_c + required_r + required_b

    missing_cats = [c for c in all_required if c not in categories]
    if not missing_cats:
        r.pass_(f"类别覆盖完整: C01-C24 + R01-R05 + B01-B02 全覆盖")
    else:
        r.fail(f"缺失类别: {missing_cats}")

    # 检查 8: 每类样本数
    low_count_cats = []
    for cat in all_required:
        count = categories.get(cat, 0)
        if cat.startswith("C"):
            min_required = 3
        elif cat.startswith("R"):
            min_required = 3
        elif cat.startswith("B"):
            min_required = 4
        else:
            continue
        if count < min_required:
            low_count_cats.append((cat, count, min_required))
    if not low_count_cats:
        r.pass_(f"每类样本数达标（C≥3, R≥3, B≥4）: {dict(categories)}")
    else:
        for cat, count, min_req in low_count_cats:
            r.fail(f"类别 {cat} 只有 {count} 条，需 ≥{min_req}")

    # 检查 9: 标注置信度 high 占比 ≥ 70%
    confidences = Counter(rec.get("confidence") for rec in records)
    high_count = confidences.get("high", 0)
    high_ratio = high_count / len(records) if records else 0
    if high_ratio >= 0.7:
        r.pass_(f"置信度 high 占比 {high_ratio:.1%} ≥ 70% ({high_count}/{len(records)})")
    else:
        r.fail(f"置信度 high 占比 {high_ratio:.1%} < 70% ({high_count}/{len(records)})")

    # 检查 10: id 唯一
    ids = [rec.get("id") for rec in records]
    dup_ids = [id_ for id_, count in Counter(ids).items() if count > 1]
    if not dup_ids:
        r.pass_("id 全局唯一")
    else:
        r.fail(f"重复 id: {dup_ids}")

    return r


def check_memory_recall():
    r = CheckResult("findRelevantMemories 评测集")

    if not RM_FILE.exists():
        r.fail(f"文件不存在: {RM_FILE}")
        return r

    records = load_jsonl(RM_FILE)
    if records is None:
        r.fail("JSONL 解析失败")
        return r

    # 检查 1: 总数 ≥ 30
    if len(records) >= 30:
        r.pass_(f"总数 {len(records)} ≥ 30")
    else:
        r.fail(f"总数 {len(records)} < 30")

    # 检查 2: 字段完整性
    # relevant_memory_ids 允许空数组（S04-no-relevant 场景），其他必填字段不允许空
    required_fields = ["id", "query", "available_memories", "relevant_memory_ids",
                       "relevance_difficulty", "scenario", "confidence"]
    missing_field_records = []
    for rec in records:
        for f in required_fields:
            if f not in rec:
                missing_field_records.append((rec.get("id", "?"), f))
            elif f == "relevant_memory_ids":
                # 允许空数组，但必须是 list
                if not isinstance(rec[f], list):
                    missing_field_records.append((rec.get("id", "?"), f))
            elif not rec[f]:
                missing_field_records.append((rec.get("id", "?"), f))
    if not missing_field_records:
        r.pass_(f"所有 {len(required_fields)} 个必填字段完整")
    else:
        for id_, f in missing_field_records[:5]:
            r.fail(f"记录 {id_} 缺字段 {f}")

    # 检查 3: relevant_memory_ids 中的 id 必须在 available_memories 里存在
    orphan_ids = []
    for rec in records:
        avail_ids = {m.get("memory_id") for m in rec.get("available_memories", [])}
        for rid in rec.get("relevant_memory_ids", []):
            if rid not in avail_ids:
                orphan_ids.append((rec.get("id"), rid))
    if not orphan_ids:
        r.pass_("所有 relevant_memory_ids 都在 available_memories 中存在")
    else:
        for rec_id, rid in orphan_ids[:5]:
            r.fail(f"记录 {rec_id}: relevant id {rid} 不在 available_memories")

    # 检查 4: no-relevant 场景的 relevant_memory_ids 必须为空
    no_rel_records = [rec for rec in records if rec.get("scenario") == "S04-no-relevant"]
    bad_no_rel = [rec.get("id") for rec in no_rel_records if rec.get("relevant_memory_ids")]
    if not bad_no_rel:
        r.pass_(f"S04-no-relevant 场景 {len(no_rel_records)} 条，relevant_memory_ids 全为空")
    else:
        r.fail(f"S04-no-relevant 但 relevant_memory_ids 非空: {bad_no_rel}")

    # 检查 5: 场景覆盖 S01-S06
    scenarios = Counter(rec.get("scenario") for rec in records)
    required_scenarios = ["S01-single-relevant-easy", "S02-single-relevant-medium",
                          "S03-multi-relevant", "S04-no-relevant",
                          "S05-weak-relevant-hard", "S06-cross-type-relevant"]
    missing_scenarios = [s for s in required_scenarios if s not in scenarios]
    if not missing_scenarios:
        r.pass_(f"场景覆盖完整 S01-S06: {dict(scenarios)}")
    else:
        r.fail(f"缺失场景: {missing_scenarios}")

    # 检查 6: memory 类型覆盖（relevant_memory_ids 引用的 memory 类型）
    relevant_type_count = Counter()
    for rec in records:
        avail_map = {m.get("memory_id"): m.get("type") for m in rec.get("available_memories", [])}
        for rid in rec.get("relevant_memory_ids", []):
            t = avail_map.get(rid)
            if t:
                relevant_type_count[t] += 1

    required_types = ["user", "feedback", "project", "reference"]
    low_types = [t for t in required_types if relevant_type_count.get(t, 0) < 5]
    if not low_types:
        r.pass_(f"memory 类型覆盖（每类≥5 相关样本）: {dict(relevant_type_count)}")
    else:
        r.fail(f"memory 类型覆盖不足（需≥5）: {low_types}, 实际 {dict(relevant_type_count)}")

    # 检查 7: relevance_difficulty 取值
    valid_diff = {"easy", "medium", "hard"}
    diffs = Counter(rec.get("relevance_difficulty") for rec in records)
    invalid_diff = [d for d in diffs if d not in valid_diff]
    if not invalid_diff:
        r.pass_(f"relevance_difficulty 分布: {dict(diffs)}")
    else:
        r.fail(f"非法 relevance_difficulty: {invalid_diff}")

    # 检查 8: 标注置信度 high 占比 ≥ 70%
    confidences = Counter(rec.get("confidence") for rec in records)
    high_count = confidences.get("high", 0)
    high_ratio = high_count / len(records) if records else 0
    if high_ratio >= 0.7:
        r.pass_(f"置信度 high 占比 {high_ratio:.1%} ≥ 70% ({high_count}/{len(records)})")
    else:
        r.fail(f"置信度 high 占比 {high_ratio:.1%} < 70% ({high_count}/{len(records)})")

    # 检查 9: id 唯一
    ids = [rec.get("id") for rec in records]
    dup_ids = [id_ for id_, count in Counter(ids).items() if count > 1]
    if not dup_ids:
        r.pass_("id 全局唯一")
    else:
        r.fail(f"重复 id: {dup_ids}")

    # 检查 10: 每条 available_memories 至少 5 条候选
    low_pool = [(rec.get("id"), len(rec.get("available_memories", [])))
                for rec in records if len(rec.get("available_memories", [])) < 5]
    if not low_pool:
        r.pass_("每条 available_memories ≥5 条候选")
    else:
        for id_, count in low_pool[:5]:
            r.fail(f"记录 {id_}: available_memories 只有 {count} 条，需 ≥5")

    return r


def main():
    print(bold("OmniAgent CLI 评测集覆盖度验证"))
    print(f"eval dir: {EVAL_DIR}")

    rc_result = check_risk_classifier()
    rm_result = check_memory_recall()

    rc_result.report()
    rm_result.report()

    print(bold("\n=== 总结 ==="))
    all_ok = rc_result.is_ok() and rm_result.is_ok()
    if all_ok:
        print(green("全部检查通过"))
        sys.exit(0)
    else:
        total_fail = len(rc_result.failed) + len(rm_result.failed)
        print(red(f"共 {total_fail} 项失败"))
        sys.exit(1)


if __name__ == "__main__":
    main()
