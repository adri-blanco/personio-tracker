const { splitHoursMinutes, formatHoursMinutes, jitterValue } = require("../lib/time-utils");

describe("splitHoursMinutes", () => {
  test.each([
    ["900", { hours: 9, minutes: 0 }],
    ["1800", { hours: 18, minutes: 0 }],
    ["1400", { hours: 14, minutes: 0 }],
    ["1500", { hours: 15, minutes: 0 }],
    ["1430", { hours: 14, minutes: 30 }],
    [930, { hours: 9, minutes: 30 }],
  ])("splits %s into %o", (value, expected) => {
    expect(splitHoursMinutes(value)).toEqual(expected);
  });
});

describe("formatHoursMinutes", () => {
  test.each([
    [9, 0, { hours: "09", minutes: "00" }],
    [18, 5, { hours: "18", minutes: "05" }],
    [0, 0, { hours: "00", minutes: "00" }],
    [23, 59, { hours: "23", minutes: "59" }],
  ])("formats (%i, %i) as %o", (hours, minutes, expected) => {
    expect(formatHoursMinutes(hours, minutes)).toEqual(expected);
  });
});

describe("jitterValue", () => {
  test("adds zero offset when randomFn returns 0", () => {
    expect(jitterValue("900", 30, () => 0)).toEqual({ hours: "09", minutes: "00" });
  });

  test("adds the maximum offset when randomFn returns just under 1", () => {
    // Math.floor(0.999... * 31) === 30, the max allowed offset.
    expect(jitterValue("900", 30, () => 0.999999)).toEqual({ hours: "09", minutes: "30" });
  });

  test("rolls over into the next hour when minutes overflow", () => {
    // 1445 + 30 max jitter could roll into hour 15.
    expect(jitterValue("1445", 30, () => 0.999999)).toEqual({ hours: "15", minutes: "15" });
  });

  test("clamps at 23:59 instead of wrapping past midnight", () => {
    expect(jitterValue("2350", 30, () => 0.999999)).toEqual({ hours: "23", minutes: "59" });
  });

  test("defaults to no jitter when maxJitterMinutes is omitted", () => {
    expect(jitterValue("900", undefined, () => 0.999999)).toEqual({ hours: "09", minutes: "00" });
  });

  test("every generated value stays within [value, value + maxJitterMinutes] using real randomness", () => {
    for (let i = 0; i < 200; i += 1) {
      const { hours, minutes } = jitterValue("900", 30);
      const totalMinutes = Number(hours) * 60 + Number(minutes);
      expect(totalMinutes).toBeGreaterThanOrEqual(9 * 60);
      expect(totalMinutes).toBeLessThanOrEqual(9 * 60 + 30);
    }
  });
});
