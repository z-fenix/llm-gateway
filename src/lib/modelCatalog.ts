// 按供应商的内置模型清单：当无法从上游实时拉取（GET /v1/models 失败、
// 上游为 Anthropic 无该接口、或未填写 Base URL）时作为下拉候选兜底。
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
