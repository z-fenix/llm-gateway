1. 优化渠道支持模型表单，采用多输入框，可动态添加
2. 日志趋势，采用线图，参考cc-switch 使用统计下的使用趋势，所有趋势均采用线图
3. 设置中 `CLI 一键写入` 优化编辑，采用cc-switch供应商的`配置 JSON` 相关表单，直接编辑json,而非当前替换
4. 实现cc-switch 路由中，`整流器`功能，及相关配置
5. 更新日期选择方式，使用cc-switch使用趋势的日期选择
6. CLI 一键写入， 编辑 Claude Code 配置 添加设置当前网关 仅修改变量，保留ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL，其余使用Claude Code 默认
7. 密钥加密处理
8. 当前trace_id  非session_id
9. 趋势线异常，当前是按小时统计，按cc-switch趋势统计
10. pnpm tauri build 发布安装后，会打开命令行窗口
11. 角色路由可配置多个供应商/模型，相同角色下，支持自动路由，支持熔断
12. skills 添加已安装的skills列表，mcp同步
13. 概览、日志、会话等，需添加刷新
14. 供应商列表参考cc-switch 优化，包含相关按钮及功能，打开终端忽略