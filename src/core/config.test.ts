import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  isConfigKey,
  readConfigValue,
  setConfigValue,
} from "./config.js";

describe("config keys", () => {
  it("recognises only the settable keys", () => {
    expect(isConfigKey("autonomy")).toBe(true);
    expect(isConfigKey("order")).toBe(true);
    expect(isConfigKey("backends")).toBe(false);
  });

  it("round-trips a value through read and set", () => {
    const next = setConfigValue(DEFAULT_CONFIG, "autonomy", "high");
    expect(readConfigValue(next, "autonomy")).toBe("high");
  });
});

describe("setConfigValue", () => {
  it("normalises case and whitespace on autonomy", () => {
    expect(setConfigValue(DEFAULT_CONFIG, "autonomy", " MEDIUM ").autonomy).toBe(
      "medium",
    );
  });

  it("rejects an unknown autonomy and leaves the config alone", () => {
    expect(() => setConfigValue(DEFAULT_CONFIG, "autonomy", "yolo")).toThrow(
      /low, medium, high/,
    );
    expect(DEFAULT_CONFIG.autonomy).toBe("low");
  });

  it("accepts an order separated by commas or spaces", () => {
    expect(setConfigValue(DEFAULT_CONFIG, "order", "cursor claude").order).toEqual(
      ["cursor", "claude"],
    );
    expect(setConfigValue(DEFAULT_CONFIG, "order", "cursor, claude").order).toEqual(
      ["cursor", "claude"],
    );
  });

  it("allows a shorter order — dropping a backend is legitimate", () => {
    expect(setConfigValue(DEFAULT_CONFIG, "order", "claude").order).toEqual([
      "claude",
    ]);
  });

  it("rejects an unknown backend, an empty order, and duplicates", () => {
    expect(() => setConfigValue(DEFAULT_CONFIG, "order", "nope")).toThrow(
      /unknown backend/,
    );
    expect(() => setConfigValue(DEFAULT_CONFIG, "order", "  ")).toThrow(
      /at least one/,
    );
    expect(() => setConfigValue(DEFAULT_CONFIG, "order", "claude,claude")).toThrow(
      /repeats/,
    );
  });
});
