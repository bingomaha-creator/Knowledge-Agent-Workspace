# React UI 开发规范

状态：已确认  
适用范围：`apps/react/src/`  
文档属性：本地开发规范，不进入 Git

## 1. 文档职责

- [React 前端架构](react-frontend.md) 记录分层、依赖方向、状态归属和应用级布局。
- 本文记录页面结构、公共 UI 契约、设计 token、响应式、可访问性和样式验收规则。
- Feature spec 记录具体业务流程；阶段性 plan、review 和 handoff 只保留实施背景，不作为长期 API 文档。

本文描述默认规则，不要求为了形式一次性重写已有页面。新页面必须遵守；修改现有区域时，在不扩大风险的前提下逐步收敛。

## 2. 页面结构

### 2.1 共同应用外壳

所有 Workspace 路由共享同一个应用框架：

```text
AppLayout
├── WorkspaceSidebar
├── WorkspaceHeader
└── Main
    └── Outlet
        └── Feature Workspace
```

- `WorkspaceSidebar` 提供桌面侧栏、移动抽屉、Chat 历史和 Workspace 摘要。
- `WorkspaceHeader` 只提供全局模块导航和移动端侧栏入口，不重复当前模块标题。
- `Outlet` 内的 Feature Workspace 负责模块标题、上下文控制和业务内容。

### 2.2 三种页面骨架

页面应从以下三种骨架中选择最接近业务的一种，不强求相同 DOM。

#### A. 单内容流

用于连续阅读、输入和输出的工作区，例如 Chat：

```text
FeatureWorkspace
├── FeatureHeader
├── Local Feedback?
└── Content Flow
```

Chat 历史已经由全局侧栏承载，不为结构对称再增加 Master Pane。加载和错误状态原则上保留 `FeatureHeader`，只替换下面的内容区，避免页面层级与高度跳变。

#### B. Master–Detail

用于“列表／范围选择 + 当前详情”的页面，例如 Knowledge、Memory、Research：

```text
FeatureWorkspace
├── FeatureHeader
├── Page Feedback?
├── WorkspaceControlBar?
└── MasterDetailLayout
    ├── Master Pane
    │   ├── PaneHeader?
    │   └── Master Content
    └── Detail Pane
        ├── PaneHeader?
        └── Detail Content
```

- `WorkspaceControlBar` 只承载作用于整个工作区的搜索、筛选或上下文选择。
- 只影响 Master 列表的筛选留在 Master Pane 内，例如 Research 状态筛选。
- Pane 具有“标题／说明／操作”时优先使用 `PaneHeader`；纯列表无需为了对称强加 Header。
- `Master Content`、`Detail Content` 是结构概念，不创建 `PaneContent` 公共组件。

#### C. 上下文分区 + 内层 Master–Detail

用于先确定业务上下文和分区，再进入列表详情的页面，例如 Bug Agent：

```text
FeatureWorkspace
├── FeatureHeader
├── WorkspaceControlBar
│   ├── Context Selector
│   └── Section Tabs
├── Page Feedback?
└── Section Content
    └── MasterDetailLayout?
```

项目选择和调查／审核／案例库属于同一层上下文，可以组合在控制栏中；各分区内部再决定是否使用 Master–Detail。不要把 Bug Agent 的两层业务结构压平成万能页面组件。

### 2.3 Header 与反馈层级

- `FeatureHeader`：整个模块的唯一业务标题，使用 `h1`。
- `PaneHeader`：Master 或 Detail 的上下文标题，使用 `h2`。
- 内部卡片和正文标题继续按内容层级选择标题元素。
- 页面级反馈放在 `FeatureHeader` 后、主内容前。
- 局部操作反馈靠近产生该状态的内容，例如 Chat 消息操作错误可位于消息区与输入区之间。
- `Feedback` 只统一视觉；`tone` 与朗读语义独立，调用方按实际状态显式决定 `role="status"`、`role="alert"` 或不设置 `role`。

## 3. 组件选择

| 需求 | 优先使用 | 边界 |
| --- | --- | --- |
| 模块标题、描述、统计和主操作 | `ui/FeatureHeader` | 不负责全局导航，不读取路由或业务状态 |
| Pane 标题、说明和操作 | `ui/PaneHeader` | 不承载 Pane 正文；`mobileControls` 可在手机替换标题说明 |
| 页面级上下文、搜索和筛选排列 | `ui/WorkspaceControlBar` | 只提供外壳，不理解 project、status 等业务字段 |
| 主列表／详情和手机单 Pane 切换 | `ui/MasterDetailLayout` | 只负责布局；Feature 提供返回或切换入口 |
| 标准主／次／危险操作 | `ui/Button` | Tabs、列表行、上传 label 和图标控件不机械替换 |
| 受控单选 | `ui/Select` | 仅单选；不把它当作原生 select 的完整表单替代品 |
| 行内提示或错误 | `ui/Feedback` | 不默认添加 role，不管理自动消失或全局通知 |
| 独立卡片式内容 | `ui/Panel` | 页面内容贴边时不要为了复用重新增加外围卡片间距 |

公共 UI 不导入 Feature，不判断业务枚举，不读取 Query、Store 或 URL。业务文案、显隐条件、pending 状态和回调仍由 Feature 决定。

## 4. 设计 token

权威定义位于 `styles/GlobalStyles.ts`，调用方不得猜变量名或私自创建近义别名。

### 4.1 当前基线

| 类别 | Token | 用途 |
| --- | --- | --- |
| 圆角 | `--radius-control` | 按钮、输入和选择器 |
| 圆角 | `--radius-card` | 卡片和局部对话框 |
| 圆角 | `--radius-panel` | 完整面板外壳 |
| 间距 | `--space-1` 至 `--space-8` | 4px 至 32px 的通用间距 |
| 布局 | `--sidebar-width` | 应用侧栏默认宽度 |
| 布局 | `--pane-master-width` | Master Pane 默认宽度，当前为 21rem |
| 布局 | `--content-max` | 需要限制阅读宽度时的上限，不强制所有页面使用 |
| 颜色 | `--color-*` | 背景、文字、边框、主色、危险和成功语义 |
| 阴影 | `--shadow-soft`、`--shadow-drawer` | 面板和抽屉 |

禁止引用未定义变量，例如旧名称 `--radius-md`、`--radius-lg`、`--shadow-lg`、`--color-border-strong`。`designTokens.test.ts` 应继续检查设计 token 族的每次引用都有全局定义。

局部布局值不必全部升级为 token，例如浮层定位间距或运行时坐标。新增全局 token 前必须满足至少一项：具有稳定设计语义，或已有两个真实消费者；同时说明现有 token 为什么不适用。

## 5. 控件视觉基线

以下是默认基线，不使用固定高度裁切长文案或放大字体：

| 元素 | 最低尺寸／间距 | 文字与圆角 |
| --- | --- | --- |
| `Button` md | min-height 2.5rem；padding .45rem .85rem | 14px、650、`--radius-control` |
| `Button` sm | min-height 2.25rem；padding .35rem .7rem | 14px、650、`--radius-control` |
| `Select` trigger | min-height 2.5rem；左右为文字和箭头留空间 | 14px、`--radius-control` |
| `FeatureHeader` | min-height 4.75rem；桌面 16px × 20px | h1 18px/700；说明 12px |
| `PaneHeader` | min-height 4rem；桌面 12px × 16px | h2 16px/700；说明 12px |
| ControlBar 文本输入 | min-height 2.5rem；padding .4rem .7rem | 14px、`--radius-control` |

`min-height` 是内容可扩展的下限，不是强制最终高度。新页面必须检查长标题、pending 文案、按钮换行和 200% 放大。

## 6. 关键组件契约

### 6.1 Button

- `variant`: `primary | secondary | danger`；默认 `secondary`。
- `size`: `md | sm`；默认 `md`。
- 默认 `type="button"`；表单提交必须显式写 `type="submit"`。
- 调用方负责业务确认、pending 文案和 disabled 条件。
- `danger` 只是视觉语义，不替代删除确认。

### 6.2 FeatureHeader

- `title` 必填；`description`、`meta`、`actions` 可选。
- `title` 输出模块 `h1`，页面不再复制一层同义标题。
- `meta` 表示统计或当前状态，`actions` 表示模块主操作。
- `className` 只用于少量消费方布局扩展；不要用父级通配选择器猜 actions 内部标签。

### 6.3 PaneHeader

- `title` 必填；`description`、`actions`、`mobileControls` 可选。
- `mobileControls` 在 48rem 以下替换标题说明，用于移动端资料库或列表范围选择。
- 现有页面无需一次性重构；新页面和后续修改区域遇到相同语义时优先收敛到该契约。

### 6.4 WorkspaceControlBar

- 统一背景、padding、边框、flex 排列和移动端换行。
- 控件是否扩张、字段含义、排列优先级由 Feature 的 styled 扩展决定。
- 不增加泛化的 `button` 或 `select` 后代规则；共享 Button、Select 自己拥有控件外观。
- 当前直接子级文本输入仍可使用 ControlBar 的输入基线，后续有两个真实消费者再考虑抽取独立文本控件。

### 6.5 MasterDetailLayout

- `master`、`detail` 和 `mobilePane` 必填。
- 默认 Master 宽度为 `--pane-master-width`；只有明确业务原因和实测证据时覆盖 `masterWidth`。
- 48rem 以下只显示 `mobilePane` 指定的一侧。
- 布局组件不自动生成返回按钮；Feature 必须确保用户能切回另一侧。

### 6.6 Select

- 仅受控单选，使用 `value`、`options` 和 `onChange(value)`。
- 清除筛选必须提供合法空值选项；`placeholder` 只负责显示，不是可选项。
- 键盘高亮与已提交值分离：方向键只移动活动项，Enter／Space 提交，Escape 取消，Tab 关闭并自然移动焦点。
- 外部点击关闭但不提交，也不抢回焦点。
- 弹窗中的 Select 使用 `popupHost` 把浮层留在 dialog 语义范围内。
- Feature 不自行复制浮层定位、翻转、键盘和焦点状态机。

### 6.7 Feedback

- `tone`: `neutral | danger`，默认 `neutral`。
- `action` 用于重试等行内操作。
- 不默认添加 `role`；调用方按状态变化和紧急程度显式决定朗读语义。
- 不把 Feedback 扩展成全局通知、Toast 管理器或自动消失状态机。

## 7. 样式归属与复用

采用三层复用：

1. **Token**：稳定设计值，放在 `GlobalStyles.ts`。
2. **按需样式片段**：同一语义的 CSS 片段已在至少两个真实结构中重复，并且抽取能明显减少漂移时再建立。
3. **UI 组件**：共享结构或交互复杂度，例如 Select 的浮层、键盘和焦点管理。

Feature 内可以保留业务列表行、聊天气泡、报告正文、证据内容、字段布局和页面专属响应式样式。相同 CSS 值不等于相同语义。

- 组件专属 styled component 与组件放在同一 `.tsx` 文件并声明在模块顶层。
- 使用有含义的名字，如 `ProjectField`、`DocumentRow`，避免 `Box1`、`Header2`。
- 纯样式状态使用 transient props；稳定 DOM 语义使用 `aria-*` 或 `data-*`。
- 不引入 Tailwind、CSS Modules 或第二套默认样式体系。
- 不把业务选择器、页面布局和一次性修补持续追加到 `GlobalStyles.ts`。
- 至少存在两个真实使用场景后再抽离；不为减少文件行数创建 `mixins.ts`、万能 Form、List、Card 或 PaneContent。

## 8. 响应式与可访问性

- 48rem 是当前 Master–Detail 和公共 Header 的主要移动断点；新断点应由真实布局需要驱动。
- Grid、Flex 子项设置合理的 `min-width: 0`、`min-height: 0`，长文本、URL 和代码不得撑破页面。
- 手机端不得出现无意横向滚动，隐藏一侧 Pane 时必须保留可达的返回或切换入口。
- 使用正确原生元素和可访问名称；可见标签与控件关联，只有图标的按钮必须有名称。
- 可见焦点不能被移除或被 overflow 裁切；装饰元素不得拦截点击。
- 弹窗打开后聚焦合理控件并管理焦点范围，关闭时返回仍存在且可聚焦的入口。
- 嵌套 Select 的第一次 Escape 只关闭下拉，之后才由弹窗处理。
- 区分首次 loading、error + retry、真实空数据、筛选无结果和后台刷新失败，不为了统一视觉合并业务状态。
- 保留 `prefers-reduced-motion`；颜色不能作为唯一状态信息。

## 9. 新页面与改动验收

实现前：

- 阅读 architecture、本规范和对应 Feature spec。
- 先选择三种页面骨架之一，再明确 Header、反馈、控制栏和移动端导航归属。
- 查找已有 UI 和 token；新增公共 API 前说明至少两个消费者或共享交互复杂度。

实现后：

- 测试提交、取消、disabled、错误重试、空值筛选、重新打开和焦点恢复等用户行为。
- 浏览器至少检查桌面、48rem 断点附近、390px 和 320px；确认无横向溢出且操作可达。
- 浮层额外检查上下翻转、滚动容器、极短视口、长选项、弹窗和触屏。
- 抽查长文案、200% 放大、键盘和屏幕阅读器；无法完成的验证如实记录。
- 运行 `npm run check:react` 和 `git diff --check`，不沿用历史测试计数。

## 10. 演进原则

- 统一职责、视觉语言和交互契约，不追求所有页面相同 DOM。
- 先解决真实体验问题，再从稳定重复中提取抽象。
- 现有 Memory、Bug Agent 的局部 Header 不要求本轮批量重构；后续修改相应区域时逐步采用 `PaneHeader` 契约。
- 规范与实现冲突时，先确认是实现缺陷还是规则已过时，再更新对应一方，避免用局部覆盖长期维持两套标准。
