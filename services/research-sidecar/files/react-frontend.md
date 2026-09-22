# React Frontend Architecture

状态：已确认  
适用范围：`apps/react/`

## 1. 目标

建立职责清晰、可测试、支持响应式布局并能持续扩展的 React 前端架构。

本架构参考 Wild Oasis 的前端组织方式，采用 Page、Feature、UI、Service 和 App 分层。React 前端使用 TypeScript、styled-components、TanStack Query 和 Zustand。

本文只记录长期有效的代码组织、依赖、状态和应用布局规则，不记录开发阶段、迁移顺序、完成状态或提交计划。

## 2. 顶层目录职责

```text
src/
├── app/
├── pages/
├── features/
├── services/
├── ui/
├── hooks/
├── styles/
├── utils/
└── test/
```

### 2.1 `app`

`app` 只负责应用级组装：

- 路由配置。
- 全局 Provider 和 QueryClient。
- Workspace 应用框架的组装。
- Workspace Header 和 Sidebar 的内容组合。
- 全局导航配置。

`app` 可以组合 Page、Feature 和 UI，但不实现 Chat、Knowledge、Memory、Research 或 Bug Agent 的模块内部业务。

### 2.2 `pages`

`pages` 只负责路由页面组装：

- 读取 route params 和 search params。
- 组合 Feature 和 UI。
- 设置页面标题、操作区和页面级状态。
- 把路由输入传给对应 Feature。

Page 不直接发起 HTTP 请求，不解析 SSE，也不实现完整业务状态机。

页面文件采用目录已表达语义的简洁命名：

```text
pages/
├── Chat.tsx
├── Knowledge.tsx
├── Memory.tsx
├── Research.tsx
├── BugAgent.tsx
└── PageNotFound.tsx
```

### 2.3 `features`

`features` 存放业务模块的完整实现：

- 业务界面。
- Feature hooks。
- Zustand store 和 selector。
- TanStack Query hooks。
- 业务类型。
- reducer、校验、转换等纯函数。
- Feature 专属样式和测试。

```text
features/
├── chat/
├── knowledge/
├── memory/
├── research/
└── bug-agent/
```

Feature 默认保持扁平。只有存在明确子领域或文件数量已经影响阅读时，才进一步拆分目录。

### 2.4 `services`

`services` 统一处理外部请求和协议：

- HTTP 请求。
- SSE 连接和事件解析。
- 请求参数与响应 DTO。
- 协议错误转换。
- AbortSignal 和请求取消。

```text
services/
├── httpClient.ts
├── sseClient.ts
├── chatApi.ts
├── knowledgeApi.ts
├── memoryApi.ts
├── researchApi.ts
└── bugAgentApi.ts
```

Service 不依赖 React，不读取 Zustand store，也不操作页面状态。Service 的实现隐藏后端 URL、事件名称和原始响应结构，向 Feature 提供小而稳定的接口。

### 2.5 `ui`

`ui` 存放跨模块通用界面：

```text
ui/
├── AppLayout.tsx
├── PageHeader.tsx
├── Panel.tsx
├── Button.tsx
├── Modal.tsx
├── Spinner.tsx
├── Empty.tsx
└── ErrorState.tsx
```

UI 不包含 Chat、Research 等业务判断，也不导入 Feature。通用 UI 通过 props、children 或小型组合接口接收内容和用户意图。

### 2.6 `hooks`

`hooks` 只存放真正跨模块复用的 React 行为：

```text
hooks/
├── useDisclosure.ts
├── useMediaQuery.ts
└── useOutsideClick.ts
```

只被一个 Feature 使用的 Hook 留在对应 Feature 中。不要为了目录对称把业务 Hook 移入全局目录。

### 2.7 `styles`

`styles` 只存放全局样式：

```text
styles/
└── GlobalStyles.ts
```

`GlobalStyles.ts` 使用 styled-components 的 `createGlobalStyle` 定义 reset、字体、语义化 CSS Variables、基础焦点和 reduced-motion 等全局规则。组件和业务模块的具体样式留在对应 `.tsx` 文件中，不持续追加到 GlobalStyles。

### 2.8 `utils`

`utils` 只存放无业务归属、无 React 依赖的通用纯函数。具有明确业务含义的转换、校验或 selector 留在对应 Feature 中。

### 2.9 `test`

`test` 存放全局测试环境和跨模块测试辅助工具。Feature 专属 fixture 和测试优先与 Feature 放在一起。

## 3. 依赖方向

```text
app ────────> pages ────────> features ────────> services
 │               │                │
 └───────────────┴────────────────┴────────────> ui

features ────────> hooks / utils
ui ──────────────> hooks / utils / styles
services ────────> utils
```

允许：

- `app` 组合 Page、Feature 和 UI。
- `pages` 使用 Feature 和 UI。
- `features` 使用 Service、UI、共享 Hook 和 Utils。
- `ui` 使用共享 Hook、Utils 和全局样式。
- `services` 使用无业务归属的纯函数。

禁止：

- UI 导入 Feature。
- Service 导入 React、Page 或 Store。
- Page 直接调用 `fetch` 或解析 SSE。
- 一个 Feature 读取另一个 Feature 的内部 Store 或内部实现。
- 通用 UI 根据业务模块名称执行条件分支。
- 为了缩短 import 路径而创建大量没有明确接口价值的 `index.ts`。

## 4. 应用布局

应用布局是所有 Workspace 路由页面共同使用的应用框架，不是某一个首页的页面结构。

```text
App
└── AppLayout
    ├── WorkspaceSidebar
    │   ├── 品牌信息
    │   ├── 发起新对话
    │   ├── Chat 历史会话
    │   ├── Knowledge 摘要
    │   ├── Memory 摘要
    │   └── 设置与帮助
    │
    ├── WorkspaceHeader
    │   └── 模块导航
    │
    └── Main
        └── Outlet
```

Chat、Knowledge、Memory、Research 和 Bug Agent 页面渲染在 `Outlet` 中。路由切换只替换 Main 内的页面内容，WorkspaceSidebar 和 WorkspaceHeader 继续存在。

模块职责如下：

- `ui/AppLayout`：提供 Sidebar、Header 和 Main 的应用级网格、滚动区域及响应式容器。
- `app/WorkspaceSidebar`：负责侧栏外壳、响应式抽屉行为，并组合 Chat 历史会话、Knowledge 摘要和 Memory 摘要等 Feature 内容。
- `app/WorkspaceHeader`：负责顶栏外壳、桌面端模块导航和移动端侧栏入口，不展示当前模块标题和描述。
- `pages`：负责 Main 内对应路由页面的组装。

模块标题、描述、统计信息和主要操作由各 Feature 的模块 Header 负责，例如 KnowledgeWorkspace、MemoryWorkspace 和 BugWorkspace 的 Header。项目、资料库、搜索和筛选等业务上下文由 Feature 内的 Context/Control Bar 负责。应用顶部栏不重复表达这些信息。

WorkspaceSidebar 和 WorkspaceHeader 目前只有一个应用级使用场景，不再额外拆出 `ui/Sidebar`、`ui/Drawer` 或 `ui/Header`。当出现第二个真实复用场景后，再从实际重复中提取通用 UI。

## 5. 响应式布局

### 5.1 桌面端

- WorkspaceSidebar 持续显示。
- WorkspaceHeader 是约 56–64px 的紧凑导航栏，只显示模块导航，不重复展示模块标题和描述。
- Main 使用 Sidebar 之外的剩余空间。
- Sidebar 和 Main 分别管理自己的滚动区域，避免整个应用出现不可控的嵌套滚动。
- Grid 和 Flex 子项默认允许收缩，长文本、代码、错误信息和 URL 不得撑破页面。

### 5.2 手机端

- WorkspaceSidebar 转换为 Drawer。
- WorkspaceHeader 显示侧栏菜单按钮和当前模块短名称，不显示模块描述和完整模块导航。
- 模块导航同时出现在移动端 Drawer 中。
- Drawer 继续提供历史会话和 Workspace 摘要入口。
- Main 占满可用宽度。
- 页面不得出现无意的横向滚动。

### 5.3 响应式实现规则

- 布局优先使用 CSS media query 或 container query。
- 只有行为确实发生变化时才使用 Hook，例如 Drawer 打开后锁定页面滚动。
- 不在 Page 中读取 `window.innerWidth` 决定界面结构。
- 可点击目标需要适合触控，键盘焦点必须清晰可见。
- 动画和过渡支持 `prefers-reduced-motion`。

## 6. Feature 内部结构

Chat 模块示例：

```text
features/chat/
├── ChatWorkspace.tsx
├── SessionPanel.tsx
├── ChatPanel.tsx
├── MessageList.tsx
├── MessageCard.tsx
├── ComposerPanel.tsx
├── useChat.ts
├── useChatSessions.ts
├── chatStore.ts
├── chat.types.ts
├── chat.selectors.ts
└── ChatWorkspace.test.tsx
```

Feature 内部默认采用扁平结构。文件命名需要表达业务职责，不能只使用 `List`、`Item`、`Form` 等离开上下文后无法理解的名称。

当 Feature 内存在明确子领域时可以拆分。例如 Bug Agent 同时包含案例库和问题调查：

```text
features/bug-agent/
├── BugAgentWorkspace.tsx
├── cases/
└── investigation/
```

不要为每个 Feature 预先创建相同的 `components/`、`hooks/`、`stores/` 和 `types/` 目录。目录结构应由真实复杂度推动。

## 7. 模块接口

每个 Feature 是拥有明确接口的业务模块。Page 和 App 只应了解完成组装所需的信息，不应了解 Feature 的内部 timer、AbortController、QueryClient、Map、原始 DTO 或 Store 结构。

Feature 接口可以包含：

- 路由页面需要渲染的 Workspace。
- App 全局框架需要组合的 Sidebar Summary 或操作入口。
- 跨模块流程需要的稳定 ID 和用户意图。
- 测试和调用方能够观察的状态与结果。

Feature 内部可以继续拆分组件、Hook、Store 和纯函数，但这些内部实现不应扩散为其他模块必须学习的接口。

## 8. 状态归属

### 8.1 TanStack Query

TanStack Query 管理服务端状态，例如：

- Chat sessions、已持久化 messages 和会话配置。
- Knowledge bases 和 documents。
- Memory records。
- Research tasks。
- Bug cases。
- 请求缓存、重新获取和 mutation 状态。

### 8.2 Zustand

Zustand 管理确实需要跨多个业务组件共享的复杂客户端工作流，例如：

- Chat SSE 流式生命周期和尚未完成的临时输出。
- 需要在 Workspace 路由切换后继续存在的停止、错误和运行状态。

不要把能够由服务端数据、URL 或局部状态推导出的值重复放入 Zustand。

### 8.3 URL

URL 表达可寻址状态，例如：

- 当前模块。
- 当前会话 ID。
- Research task ID。
- Knowledge document ID。
- Bug case ID。

推荐路由形状：

```text
/chat/:sessionId?
/knowledge/:documentId?
/memory
/research/:taskId?
/bugs/:caseId?
```

刷新页面后需要恢复的对象，不应只保存在组件内存中。

### 8.4 局部状态

`useState` 或局部 reducer 管理短生命周期 UI 状态，例如：

- Drawer 或 Modal 是否打开。
- 当前折叠区域。
- 输入焦点。
- 尚未提交的局部表单交互。
- 虚拟消息列表是否位于底部以及“回到底部”交互。

派生数据通过 selector 或纯函数计算，不重复保存为新的真相源。

## 9. 跨模块协作

Feature 不直接操作另一个 Feature 的内部 Store。

典型流程：

- 从 Chat 发起 Research：传递问题、消息 ID、会话 ID 等稳定输入并导航到 Research。
- 从 Memory 打开来源会话：使用 session ID 导航到 Chat。
- 从 Chat 创建 Bug Investigation：传递稳定 ID 和初始化输入并导航到 Bug Agent。

跨模块意图由 URL、路由 state 或 App 应用级组装协调。不要把所有 Feature 的状态和操作重新集中到一个巨大的 App 模块中。

## 10. 样式归属

具体页面骨架、公共 UI 契约、设计 token、响应式和可访问性基线见 [UI 开发规范](ui-guidelines.md)。本文只保留长期架构边界，避免重复维护视觉细则。

- styled-components 是 React 前端默认的组件样式方案，不同时引入 Tailwind 或把 CSS Modules 作为第二套默认方案。
- 组件专属样式与组件实现放在同一个 `.tsx` 文件中，使用有业务含义的 styled component 名称表达结构。
- styled component 必须声明在模块顶层，不能在 React 组件函数或 render 过程中动态创建。
- reset、字体和语义化设计 token 放在 `styles/GlobalStyles.ts`；颜色、间距、圆角和阴影优先通过 CSS Variables 共享。
- UI 样式留在对应 UI 模块中，Feature 样式留在对应 Feature 模块中。Page 通常只负责组合，尽量不拥有大量样式。
- 响应式、hover、focus、伪元素和复杂选择器直接写在对应 styled component 中。
- 离散状态优先使用 `data-*` 属性或稳定的 CSS 选择器；高频变化值优先通过 CSS Variables 传入，避免为流式进度或连续数值生成大量动态样式类。
- 多个模块不得通过全局类名共享业务样式，也不得把具体业务布局持续追加到 GlobalStyles。
- 只有第三方样式接入等 styled-components 无法合理覆盖的场景，才允许增加独立 CSS 文件，并在对应模块中说明原因。

## 11. 抽象原则

- 至少存在两个真实使用场景后，再提取通用布局或行为。
- Chat、Knowledge 和 Research 即使都有两栏界面，也不默认共享完整业务布局。
- 通用 UI 只隐藏稳定的展示和交互复杂度。
- Feature 对外提供小而稳定的接口，复杂实现留在模块内部。
- 如果删除一个通用模块后，复杂度没有重新出现在多个调用方中，它可能只是没有提供足够价值的转发层。
- 不为目录完整而创建空文件或无调用方的万能组件。

`MasterDetailLayout` 等抽象需要先由真实 Feature 验证需求，不作为所有页面必须使用的基础设施。

## 12. 测试原则

- Page 测试路由输入和页面组装。
- Feature 测试用户可观察的业务行为。
- Store 测试状态转换、并发和恢复行为。
- Service 测试请求参数、SSE 事件、DTO 转换和错误映射。
- UI 测试交互、键盘操作和可访问性。
- 纯函数测试输入与输出。
- 测试通过模块接口验证行为，不依赖内部实现细节。

## 13. 演进规则

- 先实现真实功能，再从重复代码中提取抽象。
- 新增文件前先判断它属于 App、Page、Feature、Service、UI、Hook、Style 还是 Utils。
- 业务模块不得把实现临时堆入 `app`、Page 或全局 CSS。
- 结构可以随真实复杂度演进，不为了形式机械复制参考项目。
- 当架构规则发生变化时，先更新本文，再调整实现，避免文档和代码长期表达不同结构。
