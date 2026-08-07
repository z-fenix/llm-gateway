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
      expect(api.setSecuritySetting).toHaveBeenCalledWith("security.mode", "block")
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
});
