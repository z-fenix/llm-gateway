import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect } from "vitest";
import SecurityPage from "../SecurityPage";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  api: {
    getSecuritySettings: vi.fn().mockResolvedValue({
      enabled: true,
      mode: "warn",
      scan_request: true,
      scan_response: true,
      scan_unicode: false,
      scan_tools: true,
      scan_network: true,
      redact_secrets: true,
      block_on_critical: true,
      max_scan_bytes: 65536,
    }),
    setSecuritySetting: vi.fn().mockResolvedValue(undefined),
    getBuiltinSecurityRules: vi.fn().mockResolvedValue([
      {
        id: "b1",
        rule_id: "secret.api_key",
        category: "secret",
        severity: "high",
        title: "API key leak",
        description: "Detects API keys",
        toggle_key: "builtin.secret.api_key",
        enabled: true,
        created_at: 1,
      },
    ]),
    updateBuiltinSecurityRule: vi.fn().mockResolvedValue(undefined),
    resetBuiltinSecurityRules: vi.fn().mockResolvedValue(undefined),
    getCustomSecurityRules: vi.fn().mockResolvedValue([
      {
        id: "c1",
        rule_type: "blacklist",
        category: "keyword",
        pattern: "badword",
        severity: "medium",
        action: "block",
        enabled: true,
        description: null,
        created_at: 1,
      },
    ]),
    createCustomSecurityRule: vi.fn().mockResolvedValue(undefined),
    toggleCustomSecurityRule: vi.fn().mockResolvedValue(undefined),
    deleteCustomSecurityRule: vi.fn().mockResolvedValue(undefined),
    getSecurityFindings: vi.fn().mockResolvedValue([]),
  },
}));

describe("SecurityPage", () => {
  it("renders the three sections", async () => {
    render(<SecurityPage />);
    await waitFor(() =>
      expect(screen.getByText("总开关与模式")).toBeInTheDocument()
    );
    expect(screen.getByText("内置规则")).toBeInTheDocument();
    expect(screen.getByText("自定义黑白名单")).toBeInTheDocument();
  });

  it("switches mode radio and calls setSecuritySetting", async () => {
    render(<SecurityPage />);
    await waitFor(() =>
      expect(screen.getByLabelText("阻断模式")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByLabelText("阻断模式"));
    await waitFor(() =>
      expect(api.setSecuritySetting).toHaveBeenCalledWith("mode", "block")
    );
  });

  it("shows redact mode hint when mode is redact", async () => {
    vi.mocked(api.getSecuritySettings).mockResolvedValueOnce({
      enabled: true,
      mode: "redact",
      scan_request: true,
      scan_response: true,
      scan_unicode: false,
      scan_tools: true,
      scan_network: true,
      redact_secrets: false,
      block_on_critical: true,
      max_scan_bytes: 65536,
    });
    render(<SecurityPage />);
    await waitFor(() =>
      expect(screen.getByText(/脱敏模式需同时开启/)).toBeInTheDocument()
    );
  });

  it("uses substring wording for custom rule pattern placeholder", async () => {
    render(<SecurityPage />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText("匹配规则（子串）")).toBeInTheDocument()
    );
  });

  it("renders a builtin rule enable toggle", async () => {
    render(<SecurityPage />);
    await waitFor(() =>
      expect(screen.getByText("API key leak")).toBeInTheDocument()
    );
    const toggle = screen.getByRole("checkbox", { name: /API key leak/ }) as HTMLInputElement;
    expect(toggle).toBeInTheDocument();
  });

  it("重置默认需要确认", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<SecurityPage />);
    await waitFor(() => expect(screen.getByText("重置默认")).toBeInTheDocument());
    fireEvent.click(screen.getByText("重置默认"));
    expect(confirmSpy).toHaveBeenCalledWith("确定重置全部内置规则为默认?自定义启停/级别将丢失。");
    expect(api.resetBuiltinSecurityRules).not.toHaveBeenCalled();
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByText("重置默认"));
    await waitFor(() => expect(api.resetBuiltinSecurityRules).toHaveBeenCalled());
    confirmSpy.mockRestore();
  });
});
