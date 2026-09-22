# Research Sidecar

本目录保存从 `deepresearch_agent_harness` 迁入的 Python Deep Research 实现。

当前状态：M1 独立运行验证中，尚未连接 Node 或 React。研究内核与测试保持上游验证分支的内容。

## 本地运行

在仓库根目录执行：

```bash
npm run research-sidecar:neo4j
npm run dev:research-sidecar
```

Sidecar 默认监听 `http://127.0.0.1:8000`，健康检查为 `GET /api/v1/health`。开发命令读取仓库根目录的 `.env.local`，并将已有 `QWEN_*` 配置映射到参考实现使用的 OpenAI-compatible 模型配置。

本地 Neo4j 只绑定 loopback，默认开发密码为 `research-sidecar-dev`；可在命令环境中设置 `NEO4J_PASSWORD` 覆盖。Python、SQLite、artifact、cache 与语料路径均留在本目录，Node 不管理 Sidecar 进程。

## M0 验证

参考仓库当前可收集 165 个测试。其中 `tests/acceptance/test_delivery_phase8.py` 的 5 个测试专门检查上游 React 前端、三容器 Compose 和完整交付包；这些内容不属于 Sidecar，因此保留测试文件用于追溯，但不纳入迁移门禁。

Sidecar 后端基线使用其余 160 个测试：

```bash
OPENAI_API_KEY=test OPENAI_LLM_MODEL=test-model \
  python -m pytest -q --ignore=tests/acceptance/test_delivery_phase8.py
```

测试只实例化模型客户端，不发送真实请求；占位变量用于验证配置构造，不应替换真实运行环境的配置。

上游来源与本地修复见 [UPSTREAM.md](UPSTREAM.md)。
