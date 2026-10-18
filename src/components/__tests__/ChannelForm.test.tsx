import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import ChannelForm from "../ChannelForm";
import type { Channel } from "../../types";

/**
 * 编辑态夹具：api_key 为后端 list_channels 返回的打码哨兵（sk-*** + 尾 4 位）。
 * 前端永不回填展示；留空提交时原样回传，后端 update_channel 视作「未变更」保留原值。
 */
const validForm = (): Partial<Channel> => ({
  id: "c1",
  name: "测试渠道",
  supplier: "openai",
  upstream_protocol: "openai-chat",
  base_url: "https://api.openai.com",
  api_key: "sk-***test",
  models: ["gpt-4o"],
  priority: 0,
  weight: 1,
  enabled: true,
  timeout_secs: 60,
});

function renderForm(initial?: Partial<Channel>) {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(<ChannelForm initial={initial} onSubmit={onSubmit} onCancel={onCancel} />);
  return { onSubmit, onCancel };
}

/** 点击「添加模型」并在新出现的输入框中输入值。 */
function addModel(value: string) {
  fireEvent.click(screen.getByRole("button", { name: /添加模型/ }));
  const inputs = screen.getAllByPlaceholderText(/输入或选择模型/);
  fireEvent.change(inputs[inputs.length - 1], { target: { value } });
}

function fillValidInputs() {
  fireEvent.change(screen.getByPlaceholderText("名称"), { target: { value: "测试渠道" } });
  fireEvent.change(screen.getByPlaceholderText(/Base URL/), { target: { value: "https://api.openai.com" } });
  // SecretInput write-only 无 placeholder（创建态），用 aria-label 定位
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-test" } });
  addModel("gpt-4o");
  addModel("claude-sonnet");
  fireEvent.change(screen.getByPlaceholderText(/超时秒数/), { target: { value: "30" } });
}

describe("ChannelForm validation", () => {
  it("空表单：行内错误即时展示（role=alert）且应用禁用，不触发 onSubmit", () => {
    const { onSubmit } = renderForm();
    expect(screen.getByText("名称不能为空")).toHaveAttribute("role", "alert");
    expect(screen.getByText("Base URL 不能为空")).toBeInTheDocument();
    expect(screen.getByText("API Key 不能为空")).toBeInTheDocument();
    expect(screen.getByText("至少需要一个模型")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "应用" })).toBeDisabled();
    // 禁用态点击不触发提交
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("无效 Base URL 展示格式错误且应用禁用", () => {
    renderForm();
    fillValidInputs();
    fireEvent.change(screen.getByPlaceholderText(/Base URL/), { target: { value: "not-a-url" } });
    expect(screen.getByText("Base URL 格式无效")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "应用" })).toBeDisabled();
  });

  it("非 http/https 协议的 URL 被拒绝", () => {
    renderForm();
    fillValidInputs();
    fireEvent.change(screen.getByPlaceholderText(/Base URL/), { target: { value: "ftp://example.com" } });
    expect(screen.getByText("Base URL 必须是 http/https 地址")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "应用" })).toBeDisabled();
  });

  it("timeout_secs < 1 被拒绝：折叠区 summary 行显示未通过计数且应用禁用", () => {
    renderForm();
    fillValidInputs();
    fireEvent.change(screen.getByPlaceholderText(/超时秒数/), { target: { value: "0" } });
    expect(screen.getByText("超时时间必须大于等于 1 秒")).toBeInTheDocument();
    expect(screen.getByText("自定义设置：1 项未通过")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "应用" })).toBeDisabled();

    // 修复后恢复可用，summary 计数消失
    fireEvent.change(screen.getByPlaceholderText(/超时秒数/), { target: { value: "60" } });
    expect(screen.queryByText(/项未通过/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "应用" })).toBeEnabled();
  });

  it("填写合法值后提交触发 onSubmit", () => {
    const { onSubmit } = renderForm();
    fillValidInputs();
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0][0] as Channel;
    expect(submitted.name).toBe("测试渠道");
    expect(submitted.base_url).toBe("https://api.openai.com");
    expect(submitted.models).toEqual(["gpt-4o", "claude-sonnet"]);
    expect(submitted.timeout_secs).toBe(30);
  });

  it("编辑态密钥不回填（write-only），placeholder 提示已保存", () => {
    renderForm(validForm());
    const keyInput = screen.getByLabelText("API Key") as HTMLInputElement;
    expect(keyInput.value).toBe("");
    expect(keyInput.placeholder).toBe("已保存，留空保持不变");
  });

  it("编辑态 key 留空提交：api_key 原样回传原掩码哨兵值", () => {
    const { onSubmit } = renderForm(validForm());
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect((onSubmit.mock.calls[0][0] as Channel).api_key).toBe("sk-***test");
  });

  it("编辑态 key 输入新值后提交：api_key 用新值", () => {
    const { onSubmit } = renderForm(validForm());
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-new" } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect((onSubmit.mock.calls[0][0] as Channel).api_key).toBe("sk-new");
  });

  it("DSH：自定义设置折叠区存在且默认收起（details 无 open 属性），折叠字段仍在 DOM", () => {
    renderForm();
    const details = document.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.querySelector("summary")?.textContent).toContain("自定义设置");
    expect(details!.hasAttribute("open")).toBe(false);
    expect(screen.getByText("上游协议")).toBeInTheDocument();
    expect(screen.getByLabelText("优先级")).toBeInTheDocument();
    expect(screen.getByLabelText("权重")).toBeInTheDocument();
    expect(screen.getByLabelText("超时秒数")).toBeInTheDocument();
  });

  it("添加模型后输入并提交：onSubmit 收到 models 数组", () => {
    const { onSubmit } = renderForm();
    fireEvent.change(screen.getByPlaceholderText("名称"), { target: { value: "测试渠道" } });
    fireEvent.change(screen.getByPlaceholderText(/Base URL/), { target: { value: "https://api.openai.com" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-test" } });
    addModel("deepseek-chat");
    addModel("deepseek-reasoner");
    fireEvent.change(screen.getByPlaceholderText(/超时秒数/), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect((onSubmit.mock.calls[0][0] as Channel).models).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  });

  it("删除模型移除对应行：删除后提交只保留剩余模型", () => {
    const { onSubmit } = renderForm(validForm()); // models: ["gpt-4o"]
    // 再添加一个模型，使列表有 2 行
    addModel("claude-sonnet");
    fireEvent.click(screen.getAllByRole("button", { name: "删除模型" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect((onSubmit.mock.calls[0][0] as Channel).models).toEqual(["claude-sonnet"]);
  });

  it("删除全部模型后：仍提示「至少需要一个模型」且应用禁用", () => {
    const { onSubmit } = renderForm(validForm()); // models: ["gpt-4o"]
    fireEvent.click(screen.getByRole("button", { name: "删除模型" }));
    expect(screen.queryByPlaceholderText(/输入或选择模型/)).not.toBeInTheDocument();
    expect(screen.getByText("至少需要一个模型")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "应用" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "应用" }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
