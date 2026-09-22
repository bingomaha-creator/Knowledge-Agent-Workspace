---
name: research-web-3ee59f89
description: 复用已验证的web研究轨迹，完成问题拆解、同源检索、引用报告和完成验证。
version: 0.1.0
status: candidate
source_modes:
- web
created_from_runs:
- run_7a85f97bf80647958fdde9762b98e539
---

## 触发条件

1. 不要使用之前那个skill

## 输入要求

1. 明确的研究问题
2. Run 固定的信息源

## 步骤

1. 解析问题并形成可执行计划
2. 只使用 Run 允许的同源工具收集证据
3. 生成稳定 evidence_id 引用的报告
4. 运行 Completion Contract 并按类型修复

## 允许工具

1. tavily_search

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
