# Feature Specification: DSH 式表单弹框交互 + 遗留 minor 清理

**Change**: `2026-10-18-dsh-style-form-dialogs-and-minor-sweep`

**Created**: 2026-10-18

**Status**: Draft

**Input**: User description: "表单弹框，按 DSH 模型表单交互实现；清完遗留 minor"。交互基准为 DeepSeek Harness `ui-settings-models` 包（ProviderEditor/EditorFooter/ApiKeyInput 源码提炼），连同上一 change（2026-10-18-ui-redesign-direction-a-teal）验收报告中的全部 deferred minor 一次性清零。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 对话框表单按 DSH 卡片模式交互 (P1)

用户打开任意表单弹框（渠道、密钥、Skill、模型定价、MCP server、提示词）：主字段直接可见，高级字段收在「自定义设置」折叠区；必填/格式错误以字段下方行内红字呈现，校验不通过时「应用」按钮禁用；页脚左「取消」右「应用」，提交中按钮显示「应用中」且取消禁用；显式应用才落库，成功即关闭弹框。

**Why this priority**: 这是本 change 的核心交付——统一表单交互模式。

**Independent Test**: 打开每个表单弹框，验证折叠区、行内错误、按钮禁用态、busy 文案。

**Acceptance Scenarios**:

1. **Given** 渠道表单，**When** API key 留空但名称已填（编辑已有渠道），**Then** 可应用且密钥保持不变（write-only：留空=不修改）。
2. **Given** 必填项为空或格式错误，**When** 用户查看表单，**Then** 应用按钮禁用、字段下方有行内错误文案。
3. **Given** 提交进行中，**When** 用户点击取消，**Then** 取消不可用，应用按钮显示「应用中」。

### User Story 2 - API key 输入组件 (P1)

所有密钥类输入（渠道 api_key、密钥 key）使用统一的 write-only 秘密输入组件：已存值不回填（占位符提示已保存）、新输入的值自动去粘贴空白、非空时出现眼睛按钮可临时显示、值一变重新掩码、自动填充关闭（new-password）。

**Why this priority**: 密钥处理是 DSH 模式中最影响安全与习惯的部分。

**Independent Test**: 渲染组件，验证 reveal 行为、粘贴去空白、空值语义。

**Acceptance Scenarios**:

1. **Given** 编辑已存渠道，**When** 打开表单，**Then** 密钥框为空且占位符标明已保存，直接应用不改动密钥。
2. **Given** 用户粘贴带前后空白的密钥，**When** 输入，**Then** 首尾空白被去除。

### User Story 3 - 遗留 minor 清零 (P2)

上一 change 验收报告的 9 项 deferred minor 全部处理：MCP 状态点换 StatusBadge、裸按钮/表格行补 focus-visible 焦点环、gateway-refresh 事件名提常量、Settings 重启网关后广播刷新、NEUTRAL_TAG 提取共享、capabilities 权限最小化、useTheme 跨源同步、日志 seq 列 tabular-nums。

**Why this priority**: 收尾质量项，不阻塞 US1/US2。

**Independent Test**: 逐项代码检查 + 既有测试套件绿。

**Acceptance Scenarios**:

1. **Given** 全套测试与守卫，**When** 运行，**Then** 全绿且无新增豁免。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 表单弹框 MUST 采用「主字段直显 + 自定义设置折叠区（`<details>` 或等效）」结构；渠道表单主字段（名称/供应商/Base URL/支持模型/API key）直显，模型映射/上游协议/优先级/权重/超时秒数等高级项进折叠区（Base URL 为主字段直显，不进折叠区，与设计文档 tasks.md 一致）。
- **FR-002**: 表单 MUST 提供统一页脚动作行：左取消、右应用；busy 时取消禁用、应用文案切换为「应用中」。
- **FR-003**: 校验 MUST 行内呈现（字段下方红字），校验不通过时应用按钮禁用；MUST NOT 仅依赖 toast 报错。
- **FR-004**: 密钥输入 MUST 为 write-only 组件：不回填已存值、留空=不修改、粘贴去首尾空白、非空可 reveal（值变更即掩码）、autoComplete=new-password。
- **FR-005**: 表单提交成功后 MUST 关闭弹框（应用语义），失败 MUST 保留现场并显示行内错误。
- **FR-006**: 各表单的既有功能（保存命令、字段、校验规则）MUST 保持不变——本 change 只改交互模式。
- **FR-007**: 遗留 minor 九项 MUST 全部处理（见 US3 枚举）。

### Key Entities

- **SecretInput**：write-only 秘密输入共享组件（value=草稿、placeholder=已存提示、reveal 状态）。
- **FormFooter / FormField**：统一页脚动作行与「标签+控件+行内错误」字段容器。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 每个表单弹框交互行为与 DSH 模式逐项一致（折叠区/行内错误/按钮禁用/busy 文案/write-only 密钥），人工逐框目检通过。
- **SC-002**: 全部既有测试保持绿，新增交互有测试钉住；硬编码色守卫仍为 0。
- **SC-003**: 验收报告遗留 minor 清零（ledger 无未处理项）。

## Assumptions

- 弹框外壳（shadcn Dialog）保留，仅框内交互改造；不引入 DSH 的 settings path-ops 存储机制（我们仍走既有 Tauri 命令）。
- 「自定义设置」折叠区默认收起；渠道表单的名称/密钥为主字段。
- textarea 长文本（SKILL.md 内容）保持显式应用提交，不引入 Enter 提交。

## Out of Scope

- 存储层/命令层改动；渠道测试连接等功能的语义变化；Enter 键提交（DSH 模式本身用按钮提交）。

## Clarifications

- 无未决项。DSH 交互基准以源码提炼为准（ProviderEditor/EditorFooter/ApiKeyInput）。
