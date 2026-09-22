---
name: research-web-7180b7b3
description: 复用已验证的web研究轨迹，完成问题拆解、同源检索、引用报告和完成验证。
version: 0.1.0
status: active
source_modes:
- web
created_from_runs:
- run_c48d074916da4c04a8666273740acb69
---

## 触发条件

1. 写一篇详细的神经系统疾病药物治疗研究报告，要求全面比较主要疾病类型、药物类别、疗效、安全性、适用人群、局限与未来方向，并保留全部联网证据。

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
