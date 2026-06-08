# yuan-agent

> A lightweight Agent chat workspace built with Vue 3, Vite, Pinia, TypeScript and Express.

`yuan-agent` 是一个面向大模型对话与 Agent 场景的 Web 端演示项目，聚焦以下核心能力：

- 流式响应与多轮上下文管理
- RAG 检索增强与引用来源展示
- 基于标准 `MCP (Model Context Protocol)` + Function Calling 实现工具调用链路
- 语音输入与长会话性能优化

## Project Attribution and My Work

This project was rebuilt and extended from an existing Vue Agent demo, with additional work on MCP tool orchestration, RAG flow, streaming UX, deployment setup, and documentation.

在原有项目基础上，我重点补充和优化了以下内容：

- **自动检索知识库**：将 RAG 检索前置到后端编排层，当用户开启 RAG 且已有知识文档时，服务端会自动构造 `retrieve_knowledge` 工具调用，把召回片段注入模型上下文，减少模型漏调工具导致的回答不稳定。
- **MCP / Function Calling 编排增强**：通过 Express 作为 MCP Client 连接独立 MCP Server，将工具定义映射给 Qwen OpenAI-Compatible API，并打通「模型决策 → 工具执行 → 结果回填 → 前端展示」链路。
- **参考来源展开 Bug 修复**：修复 RAG 引用来源在消息卡片中展开/收起状态异常的问题，让每条回答的 citations 展示更稳定、可读。
- **部署适配**：补充生产构建、`npm start`、`PORT` / `HOST` 云平台监听配置，以及 README 中的部署、DNS、HTTPS 和健康检查说明。
- **工程化文档**：整理架构说明、流式响应流程、RAG 流程、Tool Calling 流程和投递检查清单，方便评审者快速理解项目实现。

项目适合作为以下场景的参考实现：

- AI 对话产品原型
- Agent 工作台 / Copilot 类前端
- RAG + Tool Calling 的交互链路演示
- Vue 端大模型应用工程化实践

## Features

### Streaming Chat

- 基于 `fetch + ReadableStream + TextDecoder` 解析 SSE 数据流
- 支持逐 token 输出与生成中状态提示
- 支持手动中断回答生成

### Conversation Management

- 基于 Pinia 管理当前会话、消息列表与 UI 状态
- 支持新建、切换、删除会话
- 会话数据保存在本地，刷新后仍可恢复

### RAG Knowledge Base

- 支持上传 `.md`、`.markdown`、`.txt`、`.json` 文件
- 服务端自动执行文本分块、Embedding 建索引与相似度召回
- 前端展示引用来源、片段内容与相关度，增强回答可解释性

### Tool Calling

- 基于标准 `MCP (Model Context Protocol)` 暴露工具能力
- 服务端通过 MCP Client 连接独立 MCP Server，并将工具能力映射给模型
- 已打通「模型决策 → MCP 工具调用 → 结果回填 → 前端状态可视化」链路

### Voice Input

- 基于 Web Speech API 封装语音输入能力
- 提供 `idle / recording / processing` 三态状态管理
- 识别结果自动回填到输入框

### Performance

- 使用 `defineAsyncComponent` 延迟加载核心对话面板
- 使用 `vue-virtual-scroller` 优化长会话列表渲染性能
- 在高频消息更新场景下减少不必要的 DOM 压力

## Tech Stack

### Frontend

- `Vue 3`
- `Vite`
- `Pinia`
- `TypeScript`
- `vue-virtual-scroller`
- `MarkdownIt`
- `DOMPurify`

### Backend

- `Express`
- `Multer`
- `dotenv`
- `@modelcontextprotocol/sdk`
- `zod`
- `Qwen Compatible API`

## Built-in Tools

当前内置以下工具：

- `retrieve_knowledge`：从知识库召回相关内容
- `list_knowledge_documents`：查看当前已导入文档
- `get_current_time`：获取当前系统时间

## Project Structure

```text
.
├── server/                 # Express 编排层、MCP Server 与 Qwen 对话逻辑
├── src/
│   ├── components/         # 页面与业务组件
│   ├── composables/        # 组合式 Hooks
│   ├── services/           # 接口请求、Markdown 渲染等服务层
│   ├── stores/             # Pinia 状态管理
│   ├── types/              # 类型定义
│   ├── App.vue             # 应用入口组件
│   ├── main.ts             # 前端入口
│   └── styles.css          # 全局样式
├── .env.example            # 环境变量示例
├── package.json
└── README.md
```

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

复制 `.env.example` 为 `.env.local`：

```bash
cp .env.example .env.local
```

填写以下变量：

| Name | Description | Default |
| --- | --- | --- |
| `QWEN_API_KEY` | DashScope / Qwen API Key | - |
| `QWEN_BASE_URL` | Qwen compatible endpoint | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `QWEN_MODEL` | Chat model name | `qwen-plus` |
| `QWEN_EMBEDDING_MODEL` | Embedding model name | `text-embedding-v3` |
| `SERVER_PORT` | Local server port | `8787` |

### 3. Start development server

```bash
npm run dev
```

默认启动后：

- Frontend: `http://localhost:5173/`
- Backend: `http://127.0.0.1:8787/`

### 4. Build for production

```bash
npm run build
```

## Deployment

推荐使用支持常驻 Node 服务的平台部署，例如 `Render`、`Railway`、`Zeabur` 或云服务器。该项目不是纯静态站点：前端通过 `/api/*` 访问 Express 后端，后端负责保存 `QWEN_API_KEY`、转发流式响应、执行 MCP 工具与 RAG 检索。

### Recommended Platform Setup

以 Render / Railway / Zeabur 这类 Node Web Service 为例：

| Item | Value |
| --- | --- |
| Build Command | `npm install && npm run build` |
| Start Command | `npm start` |
| Node Version | `20+` |
| Health Check | `/api/health` |

需要配置的环境变量：

| Name | Description |
| --- | --- |
| `QWEN_API_KEY` | DashScope / Qwen API Key |
| `QWEN_BASE_URL` | Qwen OpenAI-Compatible endpoint |
| `QWEN_MODEL` | Chat model, e.g. `qwen-plus` |
| `QWEN_EMBEDDING_MODEL` | Embedding model, e.g. `text-embedding-v3` |
| `HOST` | Cloud deployment should use `0.0.0.0` |
| `PORT` | Usually provided automatically by the platform |

生产环境启动后，Express 会同时托管 `dist` 前端静态资源和 `/api` 后端接口，因此部署链接可以直接访问完整 Demo。

### DNS and HTTPS

1. 在部署平台绑定自定义域名，例如 `agent.example.com`。
2. 到域名服务商添加平台要求的 `CNAME` 或 `A` 记录。
3. 等待 DNS 生效后，在平台控制台开启自动 HTTPS 证书。
4. 验证 `https://your-domain.com/api/health` 返回 `ok: true`。

### Submission Checklist

- 线上 Demo 链接可访问。
- `/api/health` 返回成功，说明 Express 与 MCP 工具链可用。
- 聊天支持流式输出。
- 上传知识文件后可以触发 RAG 引用来源。
- README 保留架构说明、关键 Prompt / Vibe 思路、Function Calling / MCP 调用逻辑、部署步骤和 DNS / HTTPS 说明。

## How It Works

### Streaming Response Flow

1. 前端向 `/api/chat/stream` 发起请求
2. 服务端调用 Qwen 对话接口
3. 前端持续读取 SSE 数据流并解析 token
4. UI 实时拼接并渲染生成内容

### RAG Flow

1. 用户上传知识文件
2. 服务端执行文本分块
3. 调用 Embedding 模型生成向量
4. 模型在回答过程中按需调用 `retrieve_knowledge`
5. 服务端返回召回结果与引用信息
6. 前端展示引用来源、片段和相关度

### Tool Calling Flow

1. 服务端启动并连接独立的 MCP Server
2. 通过 MCP Client 获取工具定义并映射给模型
3. 模型决定是否触发工具调用
4. 服务端通过 MCP Client 执行对应工具
5. 工具结果一方面回填给模型继续推理，另一方面通过 SSE 回传前端
6. 前端展示调用参数、执行状态与返回内容

## Notes

- 语音识别依赖浏览器对 `SpeechRecognition` 或 `webkitSpeechRecognition` 的支持
- 当前知识库使用服务端内存存储，服务重启后数据会清空
- 若无法访问 Qwen 服务，请优先检查 API Key、网络环境、代理与账户配额
- 当前后端使用 OpenAI Compatible 格式接入 Qwen 接口

## Roadmap

- 接入持久化向量数据库
- 补充更多工具类型与工具失败态处理
- 增加会话云端同步能力
- 支持更完整的权限控制与多用户协作

## Development Status

当前仓库适合作为功能演示与工程实践参考项目；若用于生产环境，建议继续补充：

- 持久化存储
- 鉴权与权限控制
- 日志与监控
- 更完善的错误恢复与重试机制
- 自动化测试与 CI 流程
