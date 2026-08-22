import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import ChannelForm from "../ChannelForm";
import type { Channel } from "../../types";

const validForm = (): Partial<Channel> => ({
  name: "测试渠道",
  supplier: "openai",
  upstream_protocol: "openai-chat",
  base_url: "https://api.openai.com",
  api_key: "sk-test",
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

function fillValidInputs() {
  fireEvent.change(screen.getByPlaceholderText("名称"), { target: { value: "测试渠道" } });
  fireEvent.change(screen.getByPlaceholderText(/Base URL/), { target: { value: "https://api.openai.com" } });
  fireEvent.change(screen.getByPlaceholderText("真实上游 API Key"), { target: { value: "sk-test" } });
  fireEvent.change(screen.getByPlaceholderText(/支持模型/), { target: { value: "gpt-4o, claude-sonnet" } });
  fireEvent.change(screen.getByPlaceholderText(/超时秒数/), { target: { value: "30" } });
}

describe("ChannelForm validation", () => {
  it("空表单提交：展示错误提示且不触发 onSubmit", () => {
    const { onSubmit } = renderForm();
    fireEvent.click(screen.getByText("保存"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("名称不能为空")).toBeInTheDocument();
    expect(screen.getByText("Base URL 不能为空")).toBeInTheDocument();
    expect(screen.getByText("API Key 不能为空")).toBeInTheDocument();
    expect(screen.getByText("至少需要一个模型")).toBeInTheDocument();
  });

  it("无效 Base URL 展示格式错误", () => {
    renderForm();
    fillValidInputs();
    fireEvent.change(screen.getByPlaceholderText(/Base URL/), { target: { value: "not-a-url" } });
    fireEvent.click(screen.getByText("保存"));
    expect(screen.getByText("Base URL 格式无效")).toBeInTheDocument();
  });

  it("非 http/https 协议的 URL 被拒绝", () => {
    renderForm();
    fillValidInputs();
    fireEvent.change(screen.getByPlaceholderText(/Base URL/), { target: { value: "ftp://example.com" } });
    fireEvent.click(screen.getByText("保存"));
    expect(screen.getByText("Base URL 必须是 http/https 地址")).toBeInTheDocument();
  });

  it("timeout_secs < 1 被拒绝", () => {
    renderForm();
    fillValidInputs();
    fireEvent.change(screen.getByPlaceholderText(/超时秒数/), { target: { value: "0" } });
    fireEvent.click(screen.getByText("保存"));
    expect(screen.getByText("超时时间必须大于等于 1 秒")).toBeInTheDocument();
  });

  it("填写合法值后提交触发 onSubmit", () => {
    const { onSubmit } = renderForm();
    fillValidInputs();
    fireEvent.click(screen.getByText("保存"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0][0] as Channel;
    expect(submitted.name).toBe("测试渠道");
    expect(submitted.base_url).toBe("https://api.openai.com");
    expect(submitted.models).toEqual(["gpt-4o", "claude-sonnet"]);
    expect(submitted.timeout_secs).toBe(30);
  });

  it("编辑模式打码 api_key 不影响提交", () => {
    const { onSubmit } = renderForm(validForm());
    fireEvent.click(screen.getByText("保存"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].api_key).toBe("sk-test");
  });
});
