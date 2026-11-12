const ROLE_NAMES: Record<string, string> = {
  sonnet: "均衡任务",
  opus: "复杂任务",
  fable: "通用任务",
  haiku: "轻量任务",
  image: "图像任务",
  auto: "自动选择",
};

export function roleName(role: string): string {
  return ROLE_NAMES[role] ?? role;
}

export function roleLabel(role: string): string {
  const name = ROLE_NAMES[role];
  return name ? `${name}（${role}）` : role;
}
