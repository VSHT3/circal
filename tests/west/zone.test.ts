import { describe, expect, it } from "vitest";

describe("the west project runs west of UTC", () => {
  it("pins TZ to America/Los_Angeles", () => {
    expect(process.env.TZ).toBe("America/Los_Angeles");
  });

  it("actually applies it to Date", () => {
    // Midsummer, so this is PDT: UTC-7, and `getTimezoneOffset` is minutes
    // *behind* UTC expressed positive.
    expect(new Date("2026-07-01T12:00:00Z").getTimezoneOffset()).toBe(420);
  });
});
