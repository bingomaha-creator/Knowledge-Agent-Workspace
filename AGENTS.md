# Repository Instructions

适用范围：本仓库。本文是 Coding Agent 的唯一仓库级指令入口。

## 阅读顺序

修改代码前先读 `docs/README.md`，再读相关的 Architecture 与业务 Spec。只有任务明确引用时才读当前 Plan、Review 或 Handoff；归档材料不是当前实现要求。

- 修改 `apps/react/`：`docs/architecture/react-frontend.md`；涉及页面、样式或交互时再读 `docs/architecture/ui-guidelines.md`。
- 修改 `server/`：`docs/architecture/server.md`。
- 修改 Chat：`docs/specs/chat.md`；涉及按文档 ID 读取正文时再读 `docs/specs/chat-document-reading.md`。
- 修改 Knowledge、Memory、Bug Agent：分别读 `docs/specs/knowledge.md`、`docs/specs/memory.md`、`docs/specs/bug-agent.md`。
- 修改 Research：`docs/specs/research.md`；涉及 Harness、联网证据或完成策略时再读 `docs/specs/research-harness.md`。

本地 `docs/` 可能不在 Git 提交中；若文档不可用，先核对现有代码和测试，不自行假定旧 Plan 是规范。

## 通用执行约束

- 保留用户已有或未提交的修改；只处理任务范围，不顺手重写其他业务。
- 为真实复杂度建立小而清楚的外部接口，不创建纯转发模块、假想适配或空目录。
- 业务行为变化与纯目录迁移分开；迁移时更新全部引用及运行时路径，不留下旧路径 re-export。
- 测试跟随受影响的业务行为；不能完成的验证如实说明，不沿用历史测试数字。

## React

- `app` 负责路由、Provider 与应用级装配；`pages` 只负责路由页面组装。
- `features` 拥有业务界面、状态、Hook、类型、规则和相邻测试；不读取其他 Feature 的内部 Store。
- `services` 负责 HTTP、SSE、DTO、取消与协议错误，不依赖 React；Page 不直接调用 `fetch` 或解析 SSE。
- `ui` 只提供跨业务界面，不导入 Feature，也不判断业务状态。
- 组件专属样式与组件放在同一个 `.tsx` 文件，styled component 声明在模块顶层；全局样式和已定义设计 Token 以 `GlobalStyles.ts` 为准。不引入第二套默认样式体系。

## Server

- 业务路由、状态、流程、专属 Prompt 与测试留在 `server/modules/<feature>/`。
- Qwen、MCP Client、Web Provider 等外部通信实现留在 `server/infrastructure/`；MCP 工具注册和协议映射留在 `server/mcp-server/`。
- `server/shared/` 只接纳多个真实业务模块复用、无单一业务归属的能力；Infrastructure 和 Shared 不依赖业务模块。
- 业务模块不要导入另一业务模块的内部 Store 或流程；跨模块协作经明确接口和组合入口注入。
- 单模块测试与源码相邻；跨模块测试放 `integration/`，固定评测放 `regression/`。测试数据库使用临时路径，不修改 `server/data/`。
- 创建 `server/modules/research-new/` 时，不导入旧 `research/` 的内部实现；只复用清楚界定的基础设施和 Shared，验证完成后不长期保留双引擎。

## 验证

- Server 修改运行 `npm test`。
- React 修改或前后端协议变化运行 `npm run check:react`。
- 所有代码修改运行 `git diff --check`；涉及页面体验时按 UI Guidelines 做实际视口与可访问性检查，无法完成时说明。
