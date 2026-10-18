/**
 * 网关状态刷新事件的唯一真名。
 * Layout 顶栏监听；Dashboard/Logs 手动与自动刷新、Settings 重启成功后 dispatch，
 * 用于同步顶栏网关运行状态。
 */
export const GATEWAY_REFRESH_EVENT = "gateway-refresh";
