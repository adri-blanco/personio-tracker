// Pure time parsing/formatting/jitter helpers. No DOM or chrome.* dependency,
// so this file can be loaded unmodified both as a content script (via
// manifest.json, attached to `self`) and via `require()` in Jest tests.
(function (global) {
  // A single fixed value like "1400" always means HH:00 for this workflow,
  // so the last 2 digits are always minutes and everything before them is
  // hours (e.g. "900" -> hours 9, minutes 0).
  function splitHoursMinutes(value) {
    const str = String(value);
    return { hours: parseInt(str.slice(0, -2) || "0", 10), minutes: parseInt(str.slice(-2), 10) };
  }

  function formatHoursMinutes(hours, minutes) {
    return { hours: String(hours).padStart(2, "0"), minutes: String(minutes).padStart(2, "0") };
  }

  // Adds a fresh random offset in [0, maxJitterMinutes] to the given value,
  // e.g. 900 with a 30-minute max becomes a random time between 09:00 and
  // 09:30. Clamped to 23:59 instead of wrapping past midnight. `randomFn`
  // defaults to Math.random but can be injected for deterministic tests.
  function jitterValue(value, maxJitterMinutes, randomFn) {
    const random = randomFn || Math.random;
    const maxJitter = maxJitterMinutes || 0;
    const { hours, minutes } = splitHoursMinutes(value);
    const jitterMinutes = Math.floor(random() * (maxJitter + 1));
    const totalMinutes = Math.min(hours * 60 + minutes + jitterMinutes, 23 * 60 + 59);
    return formatHoursMinutes(Math.floor(totalMinutes / 60), totalMinutes % 60);
  }

  const api = { splitHoursMinutes, formatHoursMinutes, jitterValue };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.PersonioTimeUtils = api;
  }
})(typeof self !== "undefined" ? self : globalThis);
