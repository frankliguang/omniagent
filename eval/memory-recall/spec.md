# findRelevantMemories 评测集规范

> 用途：测试 OmniAgent CLI `findRelevantMemories` 召回机制的质量。
> 阻塞里程碑：M1 召回机制开发前 P0 前置门槛。
> 冻结决策依据：附件 A 决策 C2（轻量级 LLM 召回）。
> 数据来源：AI 生成种子 + 人工校验冻结。
> 目标规模：≥30 条标注会话。

---

## 1. 评测目标

`findRelevantMemories(query, max_tokens=256)` 用轻量级 LLM 召回相关项目记忆，注入到当前对话的 system prompt。评测集用于验证召回质量：

| 指标 | 目标 | 含义 |
|------|------|------|
| recall@5 | ≥ 0.8 | 前 5 个召回结果中包含相关 memory 的比例（不能漏掉相关 memory） |
| precision@5 | ≥ 0.7 | 前 5 个召回结果中相关 memory 的比例（允许少量噪声） |
| 评测集规模 | ≥ 30 条 | 覆盖 4 种 memory 类型 + 相关性难度 + 多 memory + 无相关场景 |
| 标注置信度 | high 占比 ≥ 70% | 标注质量基线 |

**错误代价不对称**：漏掉相关 memory（假阴性）代价低（对话可继续，用户可能重复提供信息），召回无关 memory（假阳性）代价中（token 浪费，上下文污染）。故 recall 优先（≥0.8），precision 适中（≥0.7）。

---

## 2. Schema 定义

每条记录为 JSONL 一行，字段如下：

```jsonc
{
  "id": "RM-001",                        // 唯一标识，格式 RM-NNN
  "query": "为什么测试失败了",            // 用户查询（会话中的某个问题/请求）
  "available_memories": [                // 候选 memory 列表（项目记忆库）
    {
      "memory_id": "M-001",              // memory 唯一标识
      "type": "feedback",                // memory 类型：user | feedback | project | reference
      "content": "提交前必跑 bun test",  // memory 内容
      "scope": "project"                 // memory 作用域：project | user
    },
    // ... 更多候选 memory
  ],
  "relevant_memory_ids": ["M-001"],      // 人工标注的相关 memory id 列表（真实相关集）
  "relevance_difficulty": "easy",        // 相关性难度：easy | medium | hard
  "scenario": "single-relevant",         // 场景类型（见 §4 场景清单）
  "confidence": "high",                  // 标注置信度：high | medium | low
  "notes": "明确相关，单 memory"          // 标注说明（可选）
}
```

**字段约束**：
- `id` 全局唯一，从 RM-001 递增
- `query` 是真实的用户查询文本（不是关键词，是完整的问题/请求）
- `available_memories` 是候选池，规模 5-15 条（模拟真实项目记忆库规模）
- `relevant_memory_ids` 是人工标注的"应该被召回"的 memory id 列表
  - 空数组 `[]` 表示该 query 没有相关 memory（测 precision，应召回 0 条）
  - 1 个元素表示单 memory 相关
  - 多个元素表示多 memory 相关
- `relevance_difficulty` 标注召回难度：
  - `easy`：明确相关（关键词直接匹配）
  - `medium`：间接相关（语义关联，需理解）
  - `hard`：弱相关或易混淆（测模型的判断力）
- `scenario` 见 §4 场景清单

---

## 3. Memory 类型覆盖（4 种）

评测集必须覆盖 4 种 memory 类型，每种至少 5 条相关样本：

| 类型 | 描述 | 示例 | 样本数 |
|------|------|------|--------|
| `user` | 用户角色、偏好、技能 | "用户是 Go 后端工程师，偏好函数式风格" | 7 |
| `feedback` | 用户反馈的做事方式 | "提交前必跑 bun test" | 8 |
| `project` | 项目状态、进行中的工作 | "正在重构 auth 模块，去掉 session 依赖" | 8 |
| `reference` | 外部系统指针 | "CI 在 Linear 项目 PROJ-123" | 7 |

---

## 4. 场景清单

| 场景 ID | 场景名 | 描述 | relevant_memory_ids | 样本数 |
|---------|--------|------|---------------------|--------|
| S01 | single-relevant-easy | 单 memory 相关，明确（关键词直接匹配） | 1 个 | 6 |
| S02 | single-relevant-medium | 单 memory 相关，间接（语义关联） | 1 个 | 6 |
| S03 | multi-relevant | 多 memory 相关（query 涉及多个方面） | 2-3 个 | 5 |
| S04 | no-relevant | 无相关 memory（测 precision，应召回 0 条） | 空数组 [] | 5 |
| S05 | weak-relevant-hard | 弱相关或易混淆（测模型判断力） | 1 个（低置信度） | 4 |
| S06 | cross-type-relevant | 跨类型相关（query 同时关联 user/feedback/project/reference 中的多种） | 2-4 个 | 4 |

**总数**：6+6+5+5+4+4 = 30 条

---

## 5. 验收标准

| 验收项 | 要求 | 验证方式 |
|--------|------|---------|
| 规模 | ≥ 30 条 | `wc -l dataset.jsonl` |
| 类型覆盖 | user/feedback/project/reference 各 ≥5 条 | coverage-check.sh |
| 场景覆盖 | S01-S06 全覆盖 | coverage-check.sh |
| 字段完整性 | 所有必填字段非空 | coverage-check.sh |
| 标注置信度 | high 占比 ≥ 70% | coverage-check.sh |
| 人工校验 | 100% 人工复核签字 | 校验记录表 |
| recall@5 | findRelevantMemories 在评测集上 ≥ 0.8 | M1 验收测试 |
| precision@5 | findRelevantMemories 在评测集上 ≥ 0.7 | M1 验收测试 |

---

## 6. 人工校验工作流

1. **种子生成**（已完成）：AI 基于场景模板生成 30 条初始标注，存于 `dataset.jsonl`。
2. **人工抽样复核**（上下文工程组）：每场景随机抽 30% 复核，重点检查：
   - `relevant_memory_ids` 是否正确（哪些 memory 真正相关）
   - `relevance_difficulty` 是否合理
   - `query` 是否真实（模拟真实用户问题）
3. **争议项讨论**：置信度为 low 的项，需 2 人复核达成一致；无法达成一致的剔除。
4. **补全与扩展**：若发现某类型/场景覆盖不足，人工补充样本。
5. **冻结签字**：上下文工程组 + 架构师签字，标注"已校验冻结，日期"。
6. **版本管理**：冻结后的 dataset.jsonl 进入 git，版本号 v1.0。

---

## 7. 使用方式

M1 验收时，评测集喂给 findRelevantMemories，计算 recall@5 / precision@5：

```bash
# 伪代码
total_relevant = 0
total_recalled_relevant = 0
total_recalled = 0

for record in dataset.jsonl:
    recalled_ids = find_relevant_memories(record.query, max_tokens=256, top_k=5)
    relevant_set = set(record.relevant_memory_ids)
    
    total_relevant += len(relevant_set)
    total_recalled_relevant += len(set(recalled_ids) & relevant_set)
    total_recalled += len(recalled_ids)

recall_at_5 = total_recalled_relevant / total_relevant
precision_at_5 = total_recalled_relevant / total_recalled

assert recall_at_5 >= 0.8    # 召回率 ≥ 0.8
assert precision_at_5 >= 0.7 # 精确率 ≥ 0.7
```

---

## 8. 维护与演进

- **新增样本**：M1 后基于生产 findRelevantMemories 的误召回案例，定期补充样本。
- **场景扩展**：发现新的召回失败模式时，新增场景。
- **解冻流程**：已冻结的样本变更需走 PRD 附件 A 的解冻流程。
- **版本管理**：每次冻结一个版本，记录变更原因与影响。

---

*本规范是 OmniAgent CLI PRD 附件 A 决策 C2 的落地物，由上下文工程组负责维护。*
