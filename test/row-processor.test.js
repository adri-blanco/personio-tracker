const { processRow } = require("../lib/row-processor");

// jsdom implements document.execCommand as a no-op stub, but the real
// browser genuinely mutates contenteditable text. Emulate that here so
// typeIntoSegment's flow (execCommand("insertText") -> input event) behaves
// like it does on the live page.
beforeEach(() => {
  document.execCommand = jest.fn((command, _showUI, value) => {
    if (command === "insertText" && document.activeElement) {
      document.activeElement.textContent = value;
    }
    return true;
  });
});

const SELECTORS = {
  TIME_RANGE_CELL: '[data-test-id="time-range-cell"]',
  TIME_OFF_ICON: '[data-test-id="time-off-icon"]',
  SAVE_BUTTON: '[data-test-id="timecard-save-button"]',
  CANCEL_BUTTON: '[data-test-id="timecard-cancel-button"]',
  PERIODS: [
    { key: "periods.0.start", selector: '[data-test-id="periods.0.start"]', value: "900" },
    { key: "periods.0.end", selector: '[data-test-id="periods.0.end"]', value: "1800" },
    { key: "periods.1.start", selector: '[data-test-id="periods.1.start"]', value: "1400" },
    { key: "periods.1.end", selector: '[data-test-id="periods.1.end"]', value: "1500" },
  ],
};

const TIMEOUTS = {
  WAIT_FOR_ROW_INPUTS_MS: 500,
  POLL_INTERVAL_MS: 5,
  TYPE_CHAR_DELAY_MS: 1,
};

function makeSegment(label) {
  const span = document.createElement("span");
  span.setAttribute("role", "spinbutton");
  span.setAttribute("aria-label", label);
  span.setAttribute("contenteditable", "true");
  span.tabIndex = 0;
  span.textContent = "00";
  return span;
}

function makePeriodField(testId) {
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-test-id", testId);
  wrapper.appendChild(makeSegment("hours"));
  wrapper.appendChild(makeSegment("minutes"));
  return wrapper;
}

function readField(scope, testId) {
  const wrapper = scope.querySelector(`[data-test-id="${testId}"]`);
  const [hours, minutes] = wrapper.querySelectorAll('[role="spinbutton"]');
  return `${hours.textContent}:${minutes.textContent}`;
}

// Builds the row (icon + clickable time-range cell) and, on click, opens a
// panel containing the 4 period fields plus Save/Cancel buttons - mirroring
// the real Personio page where the panel is a separate DOM subtree from the
// row, appended asynchronously after the click.
function buildRow({ swapFieldsAfterFirstPeriod = false, timeOff = false } = {}) {
  document.body.innerHTML = "";

  const row = document.createElement("div");
  const icon = document.createElement("span");
  icon.setAttribute("data-test-id", "alert-icon");
  const rangeCell = document.createElement("div");
  rangeCell.setAttribute("data-test-id", "time-range-cell");
  row.appendChild(icon);
  row.appendChild(rangeCell);
  if (timeOff) {
    const timeOffIcon = document.createElement("span");
    timeOffIcon.setAttribute("data-test-id", "time-off-icon");
    row.appendChild(timeOffIcon);
  }
  document.body.appendChild(row);

  rangeCell.addEventListener("click", () => {
    const panel = document.createElement("div");
    const fieldsScope = document.createElement("div");
    SELECTORS.PERIODS.forEach((p) => fieldsScope.appendChild(makePeriodField(p.key)));
    panel.appendChild(fieldsScope);

    const saveButton = document.createElement("button");
    saveButton.setAttribute("data-test-id", "timecard-save-button");
    const cancelButton = document.createElement("button");
    cancelButton.setAttribute("data-test-id", "timecard-cancel-button");
    panel.appendChild(saveButton);
    panel.appendChild(cancelButton);

    document.body.appendChild(panel);

    if (swapFieldsAfterFirstPeriod) {
      // Simulate the framework re-rendering and swapping in brand new DOM
      // nodes for the not-yet-filled fields, the moment the first field's
      // minutes segment reports its value. This reproduces the real bug:
      // any code that resolved all 4 field elements once upfront would now
      // be holding stale, detached references for the other 3 fields.
      const firstStart = fieldsScope.querySelector('[data-test-id="periods.0.start"]');
      const firstMinutes = Array.from(firstStart.querySelectorAll('[role="spinbutton"]')).find(
        (s) => s.getAttribute("aria-label") === "minutes"
      );
      firstMinutes.addEventListener(
        "input",
        () => {
          ["periods.0.end", "periods.1.start", "periods.1.end"].forEach((testId) => {
            const stale = fieldsScope.querySelector(`[data-test-id="${testId}"]`);
            fieldsScope.replaceChild(makePeriodField(testId), stale);
          });
        },
        { once: true }
      );
    }
  });

  return { row, icon, rangeCell };
}

describe("processRow", () => {
  test("fills all 4 period fields even when the framework swaps them out mid-row (regression for 'only fills the first one')", async () => {
    const { icon } = buildRow({ swapFieldsAfterFirstPeriod: true });

    const result = await processRow({
      icon,
      seenInputs: new Set(),
      selectors: SELECTORS,
      timeouts: TIMEOUTS,
      maxRowAncestorLevels: 8,
      jitterMaxMinutes: 0,
      dryRun: true,
      randomFn: () => 0,
    });

    expect(result.filled.map((f) => f.key)).toEqual([
      "periods.0.start",
      "periods.0.end",
      "periods.1.start",
      "periods.1.end",
    ]);

    // Re-query live: if the fix regresses to caching elements upfront, these
    // (now-swapped-in) live nodes would still show the placeholder "00:00".
    const fieldsScope = document.querySelector('[data-test-id="periods.0.end"]').parentElement;
    expect(readField(fieldsScope, "periods.0.start")).toBe("09:00");
    expect(readField(fieldsScope, "periods.0.end")).toBe("18:00");
    expect(readField(fieldsScope, "periods.1.start")).toBe("14:00");
    expect(readField(fieldsScope, "periods.1.end")).toBe("15:00");
  });

  test("fills all 4 fields normally when nothing gets swapped out", async () => {
    const { icon } = buildRow();

    await processRow({
      icon,
      seenInputs: new Set(),
      selectors: SELECTORS,
      timeouts: TIMEOUTS,
      maxRowAncestorLevels: 8,
      jitterMaxMinutes: 0,
      dryRun: true,
      randomFn: () => 0,
    });

    const fieldsScope = document.querySelector('[data-test-id="periods.0.start"]').parentElement;
    expect(readField(fieldsScope, "periods.0.start")).toBe("09:00");
    expect(readField(fieldsScope, "periods.0.end")).toBe("18:00");
    expect(readField(fieldsScope, "periods.1.start")).toBe("14:00");
    expect(readField(fieldsScope, "periods.1.end")).toBe("15:00");
  });

  test("applies jitter on top of the configured base value", async () => {
    const { icon } = buildRow();

    await processRow({
      icon,
      seenInputs: new Set(),
      selectors: SELECTORS,
      timeouts: TIMEOUTS,
      maxRowAncestorLevels: 8,
      jitterMaxMinutes: 30,
      dryRun: true,
      randomFn: () => 0.5, // Math.floor(0.5 * 31) === 15 minutes of jitter.
    });

    const fieldsScope = document.querySelector('[data-test-id="periods.0.start"]').parentElement;
    expect(readField(fieldsScope, "periods.0.start")).toBe("09:15");
  });

  test("dry run clicks Cancel and non-dry-run clicks Save", async () => {
    async function run(dryRun) {
      const { icon } = buildRow();
      // Listeners must be attached before the panel/buttons exist, so hook
      // into the row's click to attach button listeners right after the
      // panel is created (a microtask later, once processRow clicks it).
      const original = icon.parentElement.querySelector('[data-test-id="time-range-cell"]');
      const saveClicked = jest.fn();
      const cancelClicked = jest.fn();
      original.addEventListener("click", () => {
        setTimeout(() => {
          const save = document.querySelector('[data-test-id="timecard-save-button"]');
          const cancel = document.querySelector('[data-test-id="timecard-cancel-button"]');
          if (save) save.addEventListener("click", saveClicked);
          if (cancel) cancel.addEventListener("click", cancelClicked);
        }, 0);
      });

      await processRow({
        icon,
        seenInputs: new Set(),
        selectors: SELECTORS,
        timeouts: TIMEOUTS,
        maxRowAncestorLevels: 8,
        jitterMaxMinutes: 0,
        dryRun,
        randomFn: () => 0,
      });

      return { saveClicked, cancelClicked };
    }

    const dryRunResult = await run(true);
    expect(dryRunResult.cancelClicked).toHaveBeenCalledTimes(1);
    expect(dryRunResult.saveClicked).not.toHaveBeenCalled();

    const realRunResult = await run(false);
    expect(realRunResult.saveClicked).toHaveBeenCalledTimes(1);
    expect(realRunResult.cancelClicked).not.toHaveBeenCalled();
  });

  test("throws when the time-range cell can't be found for the row", async () => {
    document.body.innerHTML = "";
    const icon = document.createElement("span");
    icon.setAttribute("data-test-id", "alert-icon");
    document.body.appendChild(icon);

    await expect(
      processRow({
        icon,
        seenInputs: new Set(),
        selectors: SELECTORS,
        timeouts: TIMEOUTS,
        maxRowAncestorLevels: 8,
        jitterMaxMinutes: 0,
        dryRun: true,
        randomFn: () => 0,
      })
    ).rejects.toThrow(/time-range cell/);
  });

  test("skips rows that contain a time-off-icon instead of treating them as a normal alert", async () => {
    const { icon, rangeCell } = buildRow({ timeOff: true });
    const clicked = jest.fn();
    rangeCell.addEventListener("click", clicked);

    await expect(
      processRow({
        icon,
        seenInputs: new Set(),
        selectors: SELECTORS,
        timeouts: TIMEOUTS,
        maxRowAncestorLevels: 8,
        jitterMaxMinutes: 0,
        dryRun: true,
        randomFn: () => 0,
      })
    ).rejects.toThrow(/time-off/);

    // Bails out before clicking the time-range cell, so no panel is opened.
    expect(clicked).not.toHaveBeenCalled();
  });

  test("skips already-seen inputs so a previously-processed row isn't re-matched", async () => {
    const { icon } = buildRow();

    // Pre-populate seenInputs with what will become the *next* click's
    // periods.0.start, by processing once first.
    const seenInputs = new Set();
    await processRow({
      icon,
      seenInputs,
      selectors: SELECTORS,
      timeouts: TIMEOUTS,
      maxRowAncestorLevels: 8,
      jitterMaxMinutes: 0,
      dryRun: true,
      randomFn: () => 0,
    });

    expect(seenInputs.size).toBe(4);
  });
});
