# yuan-agent 测试知识库

## 项目背景

yuan-agent 是一个 AI 对话助手项目，支持流式输出、RAG 知识库检索、MCP 工具调用、语音输入和多轮会话管理。

这个项目的前端使用 Vue 3、Vite、TypeScript 和 Pinia。后端使用 Express、MCP Server 和 Qwen OpenAI-Compatible API。

## 核心能力

项目主要包含以下能力：

1. 流式响应：后端通过 SSE 持续返回 token，前端逐步拼接 assistant 消息。
2. 知识库检索：用户可以上传 Markdown、TXT 或 JSON 文件，后端会进行文本分块、生成 embedding，并建立内存向量索引。
3. 工具调用：后端通过 MCP 暴露工具，模型可以根据用户问题决定是否调用知识库检索工具。
4. 引用展示：当知识库命中相关内容时，前端会展示参考来源、片段内容和相关度。
5. 语音输入：浏览器支持 Web Speech API 时，用户可以通过语音把内容填入输入框。

## 测试暗号

为了验证 RAG 检索是否正常，这份测试知识库设置了一个测试暗号。

测试暗号是：蓝色星河。

如果用户询问“测试暗号是什么”，正确答案应该是“蓝色星河”。

## 项目阅读路线

阅读这个项目时，建议先从 README.md 和 package.json 建立整体认识，再阅读 src/main.ts 和 src/App.vue 理解前端启动和页面结构。

理解页面结构后，应重点阅读 src/stores/chat.ts，因为它是前端状态管理核心，负责会话、消息、知识库、RAG 开关、流式输出状态和错误提示。

然后阅读 src/services/qwen.ts，理解前端如何请求后端接口，以及如何解析 SSE 流式事件。

最后阅读 server/index.js 和 server/mcp-server.js，理解 Express 如何编排 Qwen、MCP 工具调用和 RAG 检索。

## 易错点

前端不会直接调用 Qwen API。前端只请求本地后端的 /api 接口，真正的 Qwen API Key 在服务端环境变量中读取。

知识库目前保存在服务端内存中，因此服务重启之后，已经上传的知识文件和向量索引都会丢失。

MCP 工具不是由前端直接调用的。模型先决定是否需要工具调用，然后 Express 通过 MCP Client 调用 MCP Server 中注册的工具。

## 测试问题建议

上传这份文件后，可以向助手提问：

- 这个项目有哪些核心能力？
- 测试暗号是什么？
- 前端会直接调用 Qwen API 吗？
- 为什么服务重启后知识库会丢失？
- 阅读这个项目时应该先看哪些文件？
