import { render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { vi, describe, it, expect, beforeEach } from "vitest";
import Layout, { NAV_GROUPS, SYSTEM_GROUP } from "../Layout";
import { gatewayStatus } from "../../lib/gatewayStatus";
import { GATEWAY_REFRESH_EVENT } from "../../lib/events";
import { api } from "../../lib/api";
// CJS 配置文件无类型声明；仅断言所需的最小形状
// @ts-expect-error tailwind.config.cjs has no declaration file
import tailwindConfig from "../../../tailwind.config.cjs";

const colors = (
  tailwindConfig as { theme?: { extend?: { colors?: Record<string, unknown> } } }
)?.theme?.extend?.colors;

vi.mock("../../lib/api", () => ({
  api: {
    getAppConfig: vi.fn().mockResolvedValue({
      preferred_port: 8777,
      bound_addr: "127.0.0.1:8778",
      minimize_to_tray: false,
    }),
  },
}));

const mockedApi = vi.mocked(api);

const ALL_ROUTES = [
  ["/", "概览"],
  ["/logs", "日志与会话"],
  ["/channels", "渠道"],
  ["/keys", "密钥"],
  ["/roles", "角色路由"],
  ["/security", "安全审计"],
  ["/knowledge", "资源"],
  ["/settings", "设置"],
] as const;

function renderLayout(initial = "/") {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<div>概览页占位</div>} />
          <Route path="*" element={<div>页面占位</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe("gatewayStatus", () => {
  it("danger 语义色在 Tailwind 配置中存在别名（text-danger/bg-danger 可生成 CSS）", () => {
    expect(colors?.danger).toBeTruthy();
    // destructive 保持原样（shadcn 基础组件依赖）
    expect(colors?.destructive).toBeTruthy();
  });

  it("非空地址 → success + 端口", () => {
    expect(gatewayStatus("127.0.0.1:8778")).toEqual({
      semantic: "success",
      label: "网关运行中",
      port: ":8778",
    });
  });

  it.each([null, "", undefined])(
    "空值(%s) → danger，无 port 字段",
    (addr) => {
      const status = gatewayStatus(addr);
      expect(status.semantic).toBe("danger");
      expect(status.label).toBe("网关未运行");
      expect(status.port).toBeUndefined();
    }
  );
});

describe("NAV_GROUPS", () => {
  it("包含 运行/配置/能力 三个分组（按序）", () => {
    expect(NAV_GROUPS.map((g) => g.title)).toEqual(["运行", "配置", "能力"]);
  });

  it("三个分组 + 沉底系统项覆盖全部 8 个路由", () => {
    const routes = [
      ...NAV_GROUPS.flatMap((g) => g.items.map((i) => i.to)),
      ...SYSTEM_GROUP.items.map((i) => i.to),
    ].sort();
    expect(routes).toEqual(
      ["/", "/channels", "/keys", "/knowledge", "/logs", "/roles", "/security", "/settings"].sort()
    );
  });
});

describe("Layout 渲染", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getAppConfig.mockResolvedValue({
      preferred_port: 8777,
      bound_addr: "127.0.0.1:8778",
      minimize_to_tray: false,
    });
  });

  it("渲染 运行/配置/能力 三个分组标题", () => {
    renderLayout();
    expect(screen.getByText("运行")).toBeInTheDocument();
    expect(screen.getByText("配置")).toBeInTheDocument();
    expect(screen.getByText("能力")).toBeInTheDocument();
  });

  it.each(ALL_ROUTES)("渲染入口链接 %s → %s", (href, label) => {
    renderLayout();
    expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", href);
  });

  it("设置在分隔线之后沉底渲染", () => {
    renderLayout();
    const divider = screen.getByTestId("nav-divider");
    const settings = screen.getByRole("link", { name: "设置" });
    // settings 位于 divider 之后
    expect(
      divider.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("顶栏状态反映 getAppConfig：运行中显示标签与等宽端口", async () => {
    renderLayout();
    expect(await screen.findByText("网关运行中")).toBeInTheDocument();
    expect(screen.getByText(":8778")).toBeInTheDocument();
  });

  it("未绑定地址时显示网关未运行且不显示端口", async () => {
    mockedApi.getAppConfig.mockResolvedValue({
      preferred_port: 8777,
      bound_addr: null,
      minimize_to_tray: false,
    });
    renderLayout();
    expect(await screen.findByText("网关未运行")).toBeInTheDocument();
    expect(screen.queryByText(/:\d+/)).not.toBeInTheDocument();
  });

  it("监听 gateway-refresh 事件后重新拉取 getAppConfig", async () => {
    renderLayout();
    await screen.findByText("网关运行中");
    mockedApi.getAppConfig.mockClear();
    act(() => {
      window.dispatchEvent(new CustomEvent(GATEWAY_REFRESH_EVENT));
    });
    await waitFor(() => expect(mockedApi.getAppConfig).toHaveBeenCalledTimes(1));
  });
});
