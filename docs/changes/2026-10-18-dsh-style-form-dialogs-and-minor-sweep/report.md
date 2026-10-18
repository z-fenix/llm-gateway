# 验证报告 · DSH 式表单弹框交互 + 遗留 minor 清理

**Change**: `2026-10-18-dsh-style-form-dialogs-and-minor-sweep` · **Date**: 2026-10-19 · **Branch**: `feature/dsh-form-dialogs` (3ef1f14..fdc381b, 10 commits)

## 执行的命令与输出

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过（tsc --noEmit 零输出） |
| `pnpm test:unit` | **32 files / 375 tests 全部通过**（tokens-guard 含调色板/dark:/渐变/gateway-refresh 字面量/NEUTRAL_TAG/焦点环六类守卫） |
| `git diff --stat master -- src-tauri/` | 仅 `capabilities/default.json`（store:default → allow-load/get/set/save），Rust 代码零改动 |
| `git log master..HEAD` | 10 commits：7 任务 + 2 修复轮 + 1 构建记录 |

## 逐条需求核对

- **FR-001 主字段+折叠区** ✅（渠道/MCP 落 details；PromptsPage/KnowledgePage 经最终审查 must-fix 补齐 fdc381b；RoleRoutes 无高级字段，记偏差裁决）
- **FR-002 统一页脚动作行** ✅ — 五个弹框面用 FormFooter；两个内联面手工对齐语义（记录在案的裁决）；busy「应用中/保存中」+ 取消禁用
- **FR-003 行内校验+禁用应用** ✅ — touched/submitAttempted 门控在全部八个表单面逐字一致；Toast 仅留 RoleRoutes 兜底（计划明示）与 API 结果类
- **FR-004 write-only SecretInput** ✅ — 渠道 api_key 唯一秘密字段；五项性质（不回填/哨兵回传/去空白/reveal 掩码重置/new-password）各有测试
- **FR-005 成功关弹框/失败保现场** ✅（服务器错误横幅在弹框后的既有模式未回归，记观察项）
- **FR-006 功能不变** ✅ — 命令、payload、校验规则经逐字段核对（最终审查 B 轮确认无丢失）
- **FR-007 遗留 minor 九项** ✅ — 8 项落地（build-notes.md 核销清单），#9 warning 观感留用户目检
- **SC-001 逐框目检** — 待用户 `pnpm dev` 实机确认（交付后人工验收）；**SC-002** 测试全绿+守卫 ✅；**SC-003** 遗留清零 ✅

## 裁决复核

| Ruling | 复核 |
|---|---|
| T2 编辑留空回传掩码哨兵 | 成立——payload 测试双层级钉住，后端 channel.rs 契约未动 |
| pristine 不喊错（touched 门控） | 成立——八面一致，测试钉住 |
| Skills inline-only / RoleRoutes toast 兜底 | 成立——计划明示，已实现 |
| RoleRoutes 无折叠区 | 成立——无高级字段可收，设计表为意图性描述 |
| MCP headers/env 非秘密字段 | 成立——KEY/VALUE 泛型对，无专用秘密语义 |
| 定价段 busy 文案「保存中」 | 成立——按钮名即保存，aria 锚稳定 |

## 遗留项（不阻塞合并）

非 primary 色链接焦点环正则放宽、guard 下限计数、主题订阅窄窗、MCP 负向广播测试、FormField sr-only 必填、SecretInput 类串提取、build-notes 范围注释。完整清单见 ledger。

## 结论

**PASS** —— SC-001 实机目检（pnpm dev 逐框过交互）为交付后人工验收项。
