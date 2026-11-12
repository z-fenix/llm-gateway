export interface GatewayStatus {
  semantic: "success" | "danger";
  label: string;
  port?: string;
}

/**
 * 由网关绑定地址推导顶栏状态：
 * 非空地址 → 运行中（success），端口形如 ":8778"；
 * 空/null/undefined → 未运行（danger），无端口。
 */
export function gatewayStatus(boundAddr?: string | null): GatewayStatus {
  const addr = typeof boundAddr === "string" ? boundAddr.trim() : "";
  if (addr === "") {
    return { semantic: "danger", label: "网关未运行" };
  }
  const lastColon = addr.lastIndexOf(":");
  if (lastColon < 0) {
    return { semantic: "success", label: "网关运行中" };
  }
  return {
    semantic: "success",
    label: "网关运行中",
    port: addr.slice(lastColon),
  };
}
