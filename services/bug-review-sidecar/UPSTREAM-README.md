# Code Agent Studio — 后端

这是一个面向代码仓库自动维护场景的自治 Agent 系统。项目围绕四个核心目标实现：

1. 代码仓库语义理解与动态上下文构建
2. 成本感知的任务拆解与多 Agent 协同
3. Dream + Learn Loop 的技能蒸馏、自治理与复用
4. 面向成功率、技能命中率、Token 开销与链路长度的可观测体系

当前版本强调两件事：

1. 先把系统主干做成可运行平台，而不是只给概念图
2. 尽量只依赖 Python 标准库，保证在不同环境里直接可运行

## 架构总览

系统由 12 个核心模块组成：

1. `RepositoryIndexer`：扫描仓库、构建跨文件依赖图与调用边
2. `LanguageAnalyzerSuite`：联合 Python AST、Tree-sitter 和正则抽取多语言符号图
3. `ErrorSemanticCompressor`：把冗长日志压缩成错误类型、关键栈帧、根因簇和关键词
4. `LayeredContextManager`：管理 Working Context、短期记忆、长期记忆和技能上下文
5. `SemanticRetriever`：基于 embedding、词法重叠和成功率做技能/记忆 rerank
6. `SkillRepository`：维护系统技能库、命中检索、版本治理和衰减淘汰
7. `CostAwareScheduler`：根据复杂度、技能命中和上下文预算选择单 Agent 或多 Agent
8. `ConcurrentAgentRuntime`：以线程池/进程池运行子 Agent，并为任务分配独立运行目录
9. `OpenAIPatchExecutor`：通过 OpenAI Responses API 生成结构化补丁
10. `GitHubActionsClient`：同步远程失败 run、下载日志并触发 rerun
11. `SecurityManager`：统一审批、审计、权限策略与远程执行保护
12. `MetricsCollector`：记录技能命中率、成功率、Token 消耗和任务链路长度

详细设计见 [docs/architecture.md](docs/architecture.md)。

## 目录结构

```text
backend/
├── docs/
│   └── architecture.md
├── examples/
│   ├── incidents/
│   │   ├── ci_failure.json
│   │   ├── dependency_conflict.json
│   │   └── test_regression.json
│   └── sample_repo/
├── src/repo_maintainer/
├── tests/
├── main.py
├── app.py
├── pyproject.toml
└── .env.example
```

## 快速运行

确保已安装 Python 3.12+，然后安装依赖：

```bash
cd backend
pip install -e .[dev]
```

可用命令：

```bash
# 演示模式
python main.py demo

# 分析异常
python main.py analyze --incident examples/incidents/dependency_conflict.json --repo examples/sample_repo

# 修复异常
python main.py repair --incident examples/incidents/test_regression.json --repo examples/sample_repo

# 执行 Dream+Learn Loop
python main.py dream

# 查看指标
python main.py metrics

# 查看技能库
python main.py skills

# GitHub Actions 同步失败 run
python main.py github-sync --owner octo --repo example --limit 3

# 分析 GitHub 最新失败
python main.py github-analyze --owner octo --repo example --local-repo examples/sample_repo

# 审批 GitHub 写操作
python main.py approve --scope github_write --subject octo/example --actor local-user --reason "allow rerun"

# 重跑 GitHub workflow
python main.py github-rerun --owner octo --repo example --run-id 101 --failed-only

# 查看审批列表
python main.py approvals

# 查看审计日志
python main.py audit --limit 20
```

启用真实 LLM 修复时，需要先设置 OpenAI 环境变量：

```bash
export OPENAI_API_KEY="your-api-key"
export OPENAI_MODEL="your-model"
export OPENAI_EMBEDDING_MODEL="text-embedding-3-small"
python main.py repair --incident examples/incidents/test_regression.json --repo examples/sample_repo
```

启用 GitHub / GitLab / Jenkins 远程 CI 回流时，可以按需设置：

```bash
export GITHUB_TOKEN="your-github-token"
export GITHUB_REPOSITORY="octo/example"
python main.py github-sync --limit 3
```

当 incident metadata 包含 `repo_url`，且 GitHub / GitLab token 可用时，`repair` 在沙箱验证通过并生成修复提交后，会自动创建 `agent/fix-...` 修复分支、推送到远程仓库，并为 GitHub 创建 PR、为 GitLab 创建 MR。交付结果会写入执行报告的 `Remote Delivery` 段。

```bash
export GITLAB_TOKEN="your-gitlab-token"
export GITLAB_PROJECT_ID="123"
export GITLAB_API_URL="https://gitlab.com/api/v4"
python main.py ci-sync --provider gitlab_ci --limit 3
```

```bash
export JENKINS_USERNAME="jenkins-user"
export JENKINS_TOKEN="your-jenkins-token"
export JENKINS_BASE_URL="http://localhost:8080"
export JENKINS_JOB_NAME="sample"
python main.py ci-sync --provider jenkins --limit 3
```

如果要启用真实向量后端，也可以设置：

```bash
export VECTOR_BACKEND="faiss_flat"
export RETRIEVAL_RERANKER_BACKEND="cross_encoder"
```

Milvus 示例：

```bash
export VECTOR_BACKEND="milvus"
export MILVUS_URI="http://127.0.0.1:19530"
export MILVUS_TOKEN=""
```

pgvector 示例：

```bash
export VECTOR_BACKEND="pgvector"
export PGVECTOR_DSN="postgresql://user:password@127.0.0.1:5432/repo_autonomy"
export PGVECTOR_TABLE="repo_autonomy_vectors"
```

## 已实现能力

### 1. 上下文与语义理解

- 仓库扫描与文件摘要
- Python AST 级 import / 调用边抽取
- Tree-sitter 可选增强的多语言符号抽取
- 通用 import / require 文本依赖识别
- 符号级代码图与图元数据统计
- 错误日志语义压缩
- 动态 relevant files 选择
- Token 预算分配

### 2. 调度与协同

- 复杂度评分
- 基于技能命中和跨模块范围的调度决策
- 单 Agent / 多 Agent 模式切换
- 线程池 / 进程池并发子 Agent 运行时
- 任务级独立运行目录
- 诊断 / 修复 / 验证三段式协作链路
- OpenAI Responses API 驱动的真实补丁执行器
- 结构化文件编辑计划与补丁应用
- 失败重试与验证日志回灌

### 3. 检索与记忆召回

- 向量缓存与 embedding 检索
- 技能库 / 历史记忆语义召回
- 语义分数、词法分数与成功率联合 rerank
- 本地哈希向量兜底，保证无远程 embedding 时仍可运行

### 4. 沙箱与验证闭环

- 仓库级 Git 沙箱复制
- 非 Git 仓库自动初始化基线提交
- 失败自动回滚到基线提交
- 成功后自动提交修复结果
- 成功修复后自动远程交付：创建 `agent/fix-...` 分支、push 到远程，并创建 GitHub PR / GitLab MR
- 本地测试/CI 命令推断与执行
- `pytest` 不可用时的轻量 Python 测试运行器
- GitHub Actions 失败 run 同步、本地 incident 落盘、日志下载与 rerun 触发

### 5. 安全治理与可观测

- 审批存储与 TTL 过期治理
- GitHub 写操作审批
- 远程执行审批
- 本地验证命令授权检查
- 审计日志与审批使用记录
- GitHub 事件占比、回滚率、运行时后端等指标

### 6. 自进化

- 成功执行轨迹持久化
- 睡眠阶段复盘
- 从成功修复摘要中蒸馏技能
- 技能版本升级
- 低成功率技能衰减治理

### 7. 可观测

- 技能命中率
- 成功率
- 平均 Token 消耗
- 平均任务链路长度
- 多 Agent 使用占比
- 验证通过率
- 回滚率

## 当前边界

这个版本已经从"只做规划的 MVP"升级成了"可在沙箱仓库里真实执行修复"的原型。它已经具备：

1. 上下文管理、技能治理、调度、复盘、自学习与观测能力
2. OpenAI Responses API 驱动的真实补丁生成与文件改写
3. Git 沙箱、基线提交、失败回滚和成功提交
4. 本地测试/CI 命令执行闭环
5. GitHub Actions 远程失败 run 回流、日志下载和 rerun 触发
6. embedding 检索、技能/记忆 rerank 与向量缓存
7. 多语言符号图、图元数据和更细粒度调用边
8. 并发子 Agent 运行时与任务级资源隔离
9. 审批、审计、权限策略和远程执行安全治理

仍然没有完全做完的，是更靠近生产级的平台能力：

1. 更大规模的生产级 Milvus / pgvector 服务部署、容量治理与运维基线
2. 更大规模长期记忆治理与检索基准压测
3. 某些环境里尚未预装 Tree-sitter 语法包；当前会自动退化到 AST/正则分析
4. 运行时隔离目前是进程/线程级与独立工作目录，不是容器/微虚机级沙箱
5. 审批与审计已具备基础治理，但还没有企业级 RBAC、密钥托管、脱敏和策略编排

如果你下一步希望继续扩展，建议按这个顺序推进：

1. 完成 Milvus / pgvector 的真实服务部署与运维基线
2. 做检索召回率、时延和重排序效果的系统级压测
3. 把运行时从进程隔离升级到容器沙箱
4. 补企业级审批、RBAC 与安全策略中心

## 学习与定制

如果你希望将此项目用于学习目的或定制为你自己的平台，请参考项目根目录下的 [降低难度指南](../docs/simplification-guide.md)，了解如何逐步简化项目以适应学习和教学场景。