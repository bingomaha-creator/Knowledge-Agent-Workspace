# Upstream Provenance

## 来源

- 仓库：<https://github.com/SichengLong26/deepresearch_agent_harness>
- 上游基线：`6d9096fd859a90182a7ae2938f7741894fa071b3`
- 迁入分支：`codex/graphrag-mvp-fixes`
- 迁入 HEAD：`7e3a20b3985f80a440e0f36e2cf4ecb80c8b5ddd`

## 本地验证修复

1. `11e226705af7efcb8ea078a8ae64567c2d363a53` — stabilize GraphRAG research execution
2. `27d525a1575706fd5d1473768e8c7b28b276ed46` — use architecture docs as GraphRAG corpus
3. `7e3a20b3985f80a440e0f36e2cf4ecb80c8b5ddd` — ground GraphRAG reports in source passages

## M0 导入范围

原样导入：

- `backend/`
- `src/deepresearch_agent/`
- `tests/`
- `scripts/`、`evals/`、`skills/`、`files/`
- Python 依赖、pytest、Alembic 与知识图谱构建入口

有意排除：

- 上游 `.git/`、虚拟环境、Python 缓存、数据库、模型缓存和运行 artifacts
- 上游 `frontend/`
- 同时打包上游前端与后端的三容器 `docker-compose.yaml`

上游 README 原文保存在 `README.upstream.md`。导入时对 `backend/`、`src/deepresearch_agent/` 和 `tests/` 做了递归内容对比，差异仅为未复制的 `__pycache__`。

## 测试口径

迁入 HEAD 当前收集 165 个测试。其中 5 个 `tests/acceptance/test_delivery_phase8.py` 测试验证上游完整交付包，依赖本次明确排除的上游前端和 Compose，因此不作为 Sidecar 迁移门禁。其余 160 个后端、研究、持久化和接口测试必须保持通过。

当前上游快照未包含独立 LICENSE 文件；如未来公开分发或改变用途，需要在发布前重新核对上游授权与署名要求。

## 迁移环境修正

- `requirements.txt` 补充 `greenlet==3.5.6`。上游已验证虚拟环境实际安装该依赖，但依赖文件遗漏，导致全新环境中的 SQLAlchemy AsyncEngine 无法启动；未修改业务代码。
