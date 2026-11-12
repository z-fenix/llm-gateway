# 浅色模式对比度校验记录

**Change:** 2026-10-18-ui-redesign-direction-a-teal · Task 11 Step 2
**方法:** WCAG 2.x 相对亮度公式（sRGB 线性化，0.2126/0.7152/0.0722），HSL→sRGB 换算后程序化计算。脚本：`.mulix/.runtime/2026-10-18-ui-redesign-direction-a-teal/sdd/tasks/contrast-check.mjs`（一次性工具，不入库）。
**背景色:** `--background` 与 `--card` 在浅色下均为 `#FFFFFF`，故两列比值一致。
**通过标准:** 正文文字场景 ≥ 4.5:1；辅助/图形级（`--faint` 等）≥ 3:1。

## 校验结果（令牌定稿值）

| 令牌 | 浅色 HSL | 色值 | 测对 | 对比度 | 标准 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| `--primary` | `173 81.3% 27.3%` | `#0D7E71` | background / card | 4.94:1 | ≥4.5 | PASS |
| `--success` | `152 65.1% 31.5%` | `#1C8554` | background / card | 4.66:1 | ≥4.5 | PASS |
| `--warning` | `36 60% 37.6%` | `#996B26` | background / card | 4.66:1 | ≥4.5 | PASS |
| `--destructive`（danger 别名） | `8 60% 48%` | `#C44531` | background / card | 4.97:1 | ≥4.5 | PASS |
| `--info` | `204 65% 42%` | `#2579B1` | background / card | 4.72:1 | ≥4.5 | PASS |
| `--foreground` | `194 21.3% 12%` | `#182225` | background / card | 16.21:1 | ≥4.5 | PASS |
| `--muted-foreground` | `196 10% 41.2%` | `#5F6E74` | background / card | 5.30:1 | ≥4.5 | PASS |
| `--faint`（辅助文字/图形） | `193 14.3% 55.4%` | `#7D969E` | background / card | 3.11:1 | ≥3 | PASS |

## 调整记录（before → after）

初测三个令牌不达标，按"仅降明度、保持色相/饱和度"原则做最小加深；暗色值未动。

| 令牌 | before（HSL） | before 比值 | after（HSL） | after 比值 |
| --- | --- | --- | --- | --- |
| `--success` | `152 65.1% 33.7%`（`#1E8E5A`） | 4.15:1 ❌ | `152 65.1% 31.5%`（`#1C8554`） | 4.66:1 ✅ |
| `--warning` | `36 60% 40%`（`#A37229`） | 4.19:1 ❌ | `36 60% 37.6%`（`#996B26`） | 4.66:1 ✅ |
| `--faint` | `193 14.3% 61.6%`（`#8FA5AB`） | 2.58:1 ❌ | `193 14.3% 55.4%`（`#7D969E`） | 3.11:1 ✅ |

`--primary` / `--destructive` / `--info` / `--foreground` / `--muted-foreground` 初测即达标，未调整。

## 调整后复验

- 对比度脚本复跑：8/8 全 PASS（见上表定稿值）。
- `pnpm typecheck`：通过。
- `pnpm test:unit`：31 个测试文件、313 个用例全绿（含 `src/tokens-guard.test.ts` 的硬编码调色板色与 `dark:` 死代码守卫）。
