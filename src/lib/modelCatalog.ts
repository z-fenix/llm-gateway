// 按供应商的内置参考清单：上游拉取失败或未填写 Base URL 时作为手动选择参考。
// 不代表上游实际支持；Anthropic 同样支持通过 GET /v1/models 获取真实目录。
// 仅供渠道表单「支持模型」下拉使用，实际可用模型以上游返回为准。
export const STATIC_MODEL_CATALOG: Record<string, string[]> = {
  openai: [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "o3",
    "o4-mini",
    "gpt-4-turbo",
  ],
  claude: [
    "claude-sonnet-4-5",
    "claude-opus-4-1",
    "claude-haiku-4-5",
    "claude-3-5-sonnet-latest",
    "claude-3-5-haiku-latest",
  ],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  gemini: [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ],
  // 自定义上游没有固定清单，主要靠「从上游刷新」拉取，也可直接手输。
  custom: [],
};
