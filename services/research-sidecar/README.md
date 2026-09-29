# Research Sidecar

本目录保存从 `deepresearch_agent_harness` 迁入的 Python Deep Research 实现。

当前状态：Sidecar Demo 已接入当前唯一的深度研究入口，沿用上游研究流程，并加入知识库范围隔离、引用展示与报告交付检查修复。Legacy Research 已退役；Node MVP 仅保留为配置回退。GraphRAG 为实验选项，交付检查不等于逐句语义核验，报告质量未全面验收。

## 本地运行

在仓库根目录执行：

```bash
npm run research-sidecar:neo4j
npm run dev:with-research-sidecar
```

Sidecar 默认监听 `http://127.0.0.1:8000`，健康检查为 `GET /api/v1/health`。开发命令读取仓库根目录的 `.env.local`，并将已有 `QWEN_*` 配置映射到参考实现使用的 OpenAI-compatible 模型配置。

本地 Neo4j 只绑定 loopback，默认开发密码为 `research-sidecar-dev`；可在命令环境中设置 `NEO4J_PASSWORD` 覆盖。Python、SQLite、artifact、cache 与语料路径均留在本目录，Node 不管理 Sidecar 进程。

要让新建的 Research New 任务使用 Sidecar，启动前设置：

```bash
RESEARCH_NEW_ENGINE=sidecar npm run dev:with-research-sidecar
```

资料研究现在可以选择「关键词＋向量」或「GraphRAG」，两者使用同一 Python 研究流程，当前不混合网页来源。关键词＋向量调用项目已有 Knowledge 检索，范围来自 Node 持久化的 Run，而非模型参数。

GraphRAG 只允许单个已绑定知识库。绑定由 `RESEARCH_GRAPH_MANIFEST` 指向的本地 manifest 决定（默认 `data/current-graph.json`）；每次检索校验已发布文档集合与内容哈希，资料变更、撤回或删除后拒绝旧图并要求手动重建。当前只建一张实际图，不提供多图并行服务或自动增量同步。

手动导出一个新快照（在仓库根目录执行，不修改 Knowledge，不覆盖已有目录）：

```bash
node services/research-sidecar/export-knowledge.mjs <knowledgeBaseId> services/research-sidecar/data/<new-snapshot>
```

按参考项目 `build_knowledge_graph.py` 建图时将 `FILES_DIR` 指向快照的 `files/`。该脚本会清空其连接的 Neo4j 图，必须先备份并确认连接目标；只有完整建图及来源验收成功后才能将 manifest 标为 `ready` 并激活，不能仅凭导出成功激活。

本机无 Docker 时，已安装的 Neo4j 5.22.0 可用 `npm run research-sidecar:neo4j:local` 启动。实际数据保存在项目 `data/neo4j-runtime/`，临时 ASCII 别名只解决启动器对中文路径的转义问题。Python 解释器也须使用持久路径，不链接系统会清理的临时目录。

当前本机图谱使用上述 local 启动方式；Docker 使用独立 volume，两者的数据不会自动同步，不能通过切换启动方式复用同一张图。重启服务无需重新导出或建图；请保留本地数据目录与 manifest。

## M0 验证

参考仓库当前可收集 165 个测试。其中 `tests/acceptance/test_delivery_phase8.py` 的 5 个测试专门检查上游 React 前端、三容器 Compose 和完整交付包；这些内容不属于 Sidecar，因此保留测试文件用于追溯，但不纳入迁移门禁。

Sidecar 后端基线使用其余 160 个测试：

```bash
OPENAI_API_KEY=test OPENAI_LLM_MODEL=test-model \
  python -m pytest -q --ignore=tests/acceptance/test_delivery_phase8.py
```

测试只实例化模型客户端，不发送真实请求；占位变量用于验证配置构造，不应替换真实运行环境的配置。

上游来源与本地修复见 [UPSTREAM.md](UPSTREAM.md)。
