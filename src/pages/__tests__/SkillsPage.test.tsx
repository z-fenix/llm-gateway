import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import SkillsPage from "../SkillsPage";
import { api } from "../../lib/api";
import type { Skill, SkillView } from "../../types";

vi.mock("../../lib/api", () => ({
  api: {
    listSkills: vi.fn(),
    upsertSkill: vi.fn(),
    deleteSkill: vi.fn(),
    toggleSkillEnabled: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);

const skill = (id: string, overrides: Partial<Skill> = {}): Skill => ({
  id,
  name: `skill-${id}`,
  description: `desc-${id}`,
  directory: `dir-${id}`,
  content: `# content ${id}`,
  enabled: false,
  created_at: 1,
  updated_at: 1,
  ...overrides,
});

const view = (id: string, overrides: Partial<SkillView> = {}): SkillView => ({
  skill: skill(id),
  synced: false,
  ...overrides,
});

describe("SkillsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.listSkills.mockResolvedValue([]);
    mockedApi.upsertSkill.mockResolvedValue(skill("s1"));
    mockedApi.deleteSkill.mockResolvedValue(undefined);
    mockedApi.toggleSkillEnabled.mockResolvedValue(undefined);
  });

  it("空列表展示空状态与新增引导", async () => {
    render(<SkillsPage />);
    await waitFor(() => expect(api.listSkills).toHaveBeenCalled());
    expect(screen.getByText("暂无 Skill")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新增 Skill" })).toBeInTheDocument();
  });

  it("列表渲染 name/description、目录徽标与 synced 徽标", async () => {
    mockedApi.listSkills.mockResolvedValue([
      view("s1", {
        synced: true,
        skill: skill("s1", {
          name: "文档助手",
          description: "生成项目文档",
          directory: "doc-assistant",
        }),
      }),
      view("s2", {
        synced: false,
        skill: skill("s2", {
          name: "测试助手",
          description: null,
          directory: "test-assistant",
        }),
      }),
    ]);
    render(<SkillsPage />);
    await waitFor(() => expect(screen.getByText("文档助手")).toBeInTheDocument());
    expect(screen.getByText("测试助手")).toBeInTheDocument();
    expect(screen.getByText("生成项目文档")).toBeInTheDocument();
    expect(screen.getByText("-")).toBeInTheDocument();
    expect(screen.getByText("doc-assistant")).toBeInTheDocument();
    expect(screen.getByText("test-assistant")).toBeInTheDocument();
    expect(screen.getByText("已同步")).toBeInTheDocument();
    expect(screen.getByText("未同步")).toBeInTheDocument();
  });

  it("点击启用开关调用 toggleSkillEnabled 并刷新列表", async () => {
    mockedApi.listSkills.mockResolvedValue([
      view("s1", { skill: skill("s1", { name: "待启用", enabled: false }) }),
    ]);
    render(<SkillsPage />);
    await waitFor(() => expect(screen.getByText("待启用")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(api.toggleSkillEnabled).toHaveBeenCalledWith("s1", true)
    );
    await waitFor(() => expect(api.listSkills).toHaveBeenCalledTimes(2));
  });

  it("新增 skill，填写字段后保存调用 upsertSkill", async () => {
    render(<SkillsPage />);
    await waitFor(() => expect(api.listSkills).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "新增" }));
    expect(
      await screen.findByRole("heading", { name: "新增 Skill" })
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "代码审查" },
    });
    fireEvent.change(screen.getByLabelText("描述"), {
      target: { value: "审查代码规范" },
    });
    fireEvent.change(screen.getByLabelText("目录"), {
      target: { value: "code-review" },
    });
    fireEvent.change(screen.getByLabelText("内容"), {
      target: { value: "# 代码审查指南" },
    });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.upsertSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "",
          name: "代码审查",
          description: "审查代码规范",
          directory: "code-review",
          content: "# 代码审查指南",
          enabled: false,
          created_at: 0,
          updated_at: 0,
        })
      )
    );
  });

  it("编辑对话框预填并保存保留原 id/enabled/created_at", async () => {
    mockedApi.listSkills.mockResolvedValue([
      view("s1", {
        skill: skill("s1", {
          name: "旧技能",
          description: "旧描述",
          directory: "old-dir",
          content: "# 旧内容",
          enabled: true,
          created_at: 5,
          updated_at: 5,
        }),
      }),
    ]);
    render(<SkillsPage />);
    await waitFor(() => expect(screen.getByText("旧技能")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(
      await screen.findByRole("heading", { name: "编辑 Skill" })
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("旧技能")).toBeInTheDocument();
    expect(screen.getByDisplayValue("old-dir")).toBeInTheDocument();
    expect(screen.getByDisplayValue("# 旧内容")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("内容"), {
      target: { value: "# 新内容" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.upsertSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "s1",
          name: "旧技能",
          directory: "old-dir",
          content: "# 新内容",
          enabled: true,
          created_at: 5,
        })
      )
    );
  });

  it("删除走确认对话框并调用 deleteSkill", async () => {
    mockedApi.listSkills.mockResolvedValue([
      view("s1", { skill: skill("s1", { name: "待删除" }) }),
    ]);
    render(<SkillsPage />);
    await waitFor(() => expect(screen.getByText("待删除")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(
      await screen.findByRole("heading", { name: "删除 Skill" })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认" }));
    await waitFor(() => expect(api.deleteSkill).toHaveBeenCalledWith("s1"));
  });
});
