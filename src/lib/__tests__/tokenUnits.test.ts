import { describe, expect, it } from "vitest";
import { formatTokenAmount, formatTokenInput, parseTokenAmount } from "../tokenUnits";

describe("Token 单位", () => {
  it.each([[0, "0"], [999, "999"], [1000, "1K"], [8420000, "8.42M"], [999999, "1M"], [1500000000, "1.5B"], [1000000000000, "1T"]])("自动显示 %s → %s", (value, expected) => {
    expect(formatTokenAmount(Number(value))).toBe(expected);
  });

  it.each([["", null], [" 1000 ", 1000], ["1.5M", 1500000], ["2k", 2000], ["1B", 1000000000], ["0.5万", 5000], ["2亿", 200000000], ["1,500", 1500]])("解析 %s", (value, expected) => {
    expect(parseTokenAmount(String(value))).toBe(expected);
  });

  it.each(["-1", "NaN", "Infinity", "1.2", "0.0001K", "1MK", "9,9", "9007199254740992", "10Tfoo"])('拒绝非法配额 "%s"', value => {
    expect(parseTokenAmount(value)).toBe("invalid");
  });

  it.each([0, 999, 1234567, 1000001, Number.MAX_SAFE_INTEGER])("编辑 %s 无损往返", value => {
    expect(parseTokenAmount(formatTokenInput(value))).toBe(value);
  });
});
