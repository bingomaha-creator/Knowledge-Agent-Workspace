---
name: research-graphrag-feea6f5b
description: 复用已验证的graphrag研究轨迹，完成问题拆解、同源检索、引用报告和完成验证。
version: 0.1.1
status: candidate
source_modes:
- graphrag
created_from_runs:
- run_3f4fcc4e68334477855522c46bb1f728
---

## 触发条件

1. 根据私有数据库，用三条要点概括急性缺血性脑血管病的药物治疗原则，只引用与该疾病直接相关的库内证据。

## 输入要求

1. 明确的研究问题
2. Run 固定的信息源

## 步骤

1. 解析问题并形成可执行计划
2. 只使用 Run 允许的同源工具收集证据
3. 生成稳定 evidence_id 引用的报告
4. 运行 Completion Contract 并按类型修复

## 允许工具

1. local_search
2. hybrid_search

## 失败回退

1. 证据不足时补充同源检索；权限或来源冲突时停止并报告。

## 验证方式

1. source_match
2. citation_integrity
3. claim_support
4. report_consistency

## 已知限制

1. 不得更改 Run.source_mode
2. 不得把 Memory 当作本轮证据
