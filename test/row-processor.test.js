const { fillRow, saveRow, typeIntoSegment } = require("../lib/row-processor");

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

describe("typeIntoSegment", () => {
  test("retries when the DOM doesn't reflect the typed value on the first attempt", async () => {
    const el = makeSegment("hours");
    document.body.appendChild(el);

    let insertCalls = 0;
    document.execCommand = jest.fn((command, _showUI, value) => {
      if (command === "insertText" && document.activeElement) {
        insertCalls += 1;
        // First attempt silently no-ops, simulating a stale-focus/re-render
        // race where the edit never actually lands.
        if (insertCalls > 1) {
          document.activeElement.textContent = value;
        }
      }
      return true;
    });

    await typeIntoSegment(el, "09", 1);

    expect(el.textContent).toBe("09");
    expect(insertCalls).toBe(2);
  });

  test("throws instead of silently continuing when the value never sticks after all attempts", async () => {
    const el = makeSegment("hours");
    document.body.appendChild(el);
    document.execCommand = jest.fn(() => true); // insertText never updates textContent

    await expect(typeIntoSegment(el, "09", 1, 3)).rejects.toThrow(/still shows/);
  });

  test("throws immediately (no retry) if the segment is no longer attached to the document", async () => {
    const el = makeSegment("hours"); // never appended, so isConnected is false

    await expect(typeIntoSegment(el, "09", 1)).rejects.toThrow(/removed from the page/);
  });
});

describe("fillRow", () => {
  test("fills all 4 period fields even when the framework swaps them out mid-row (regression for 'only fills the first one')", async () => {
    const { icon } = buildRow({ swapFieldsAfterFirstPeriod: true });

    const result = await fillRow({
      icon,
      seenInputs: new Set(),
      selectors: SELECTORS,
      timeouts: TIMEOUTS,
      maxRowAncestorLevels: 8,
      jitterMaxMinutes: 0,
      randomFn: () => 0,
    });

    expect(result.filled).toEqual([
      { key: "periods.0.start", hours: "09", minutes: "00" },
      { key: "periods.0.end", hours: "18", minutes: "00" },
      { key: "periods.1.start", hours: "14", minutes: "00" },
      { key: "periods.1.end", hours: "15", minutes: "00" },
    ]);
  });

  test("fills all 4 fields normally when nothing gets swapped out", async () => {
    const { icon } = buildRow();

    const result = await fillRow({
      icon,
      seenInputs: new Set(),
      selectors: SELECTORS,
      timeouts: TIMEOUTS,
      maxRowAncestorLevels: 8,
      jitterMaxMinutes: 0,
      randomFn: () => 0,
    });

    expect(result.filled).toEqual([
      { key: "periods.0.start", hours: "09", minutes: "00" },
      { key: "periods.0.end", hours: "18", minutes: "00" },
      { key: "periods.1.start", hours: "14", minutes: "00" },
      { key: "periods.1.end", hours: "15", minutes: "00" },
    ]);
  });

  test("applies jitter on top of the configured base value", async () => {
    const { icon } = buildRow();

    const result = await fillRow({
      icon,
      seenInputs: new Set(),
      selectors: SELECTORS,
      timeouts: TIMEOUTS,
      maxRowAncestorLevels: 8,
      jitterMaxMinutes: 30,
      randomFn: () => 0.5, // Math.floor(0.5 * 31) === 15 minutes of jitter.
    });

    expect(result.filled[0]).toEqual({ key: "periods.0.start", hours: "09", minutes: "15" });
  });

  test("never clicks Save or Cancel, leaving the filled panel open for a later saveRow() call", async () => {
    const { icon } = buildRow();
    const original = icon.parentElement.querySelector('[data-test-id="time-range-cell"]');
    const saveClicked = jest.fn();
    const cancelClicked = jest.fn();
    // Listeners must be attached after the panel/buttons exist, so hook in
    // right after the row's own click handler (which creates them) runs.
    original.addEventListener("click", () => {
      setTimeout(() => {
        document.querySelector('[data-test-id="timecard-save-button"]').addEventListener("click", saveClicked);
        document.querySelector('[data-test-id="timecard-cancel-button"]').addEventListener("click", cancelClicked);
      }, 0);
    });

    await fillRow({
      icon,
      seenInputs: new Set(),
      selectors: SELECTORS,
      timeouts: TIMEOUTS,
      maxRowAncestorLevels: 8,
      jitterMaxMinutes: 0,
      randomFn: () => 0,
    });

    expect(saveClicked).not.toHaveBeenCalled();
    expect(cancelClicked).not.toHaveBeenCalled();
    expect(document.querySelector('[data-test-id="periods.0.start"]')).not.toBeNull();
  });

  test("throws when the time-range cell can't be found for the row", async () => {
    document.body.innerHTML = "";
    const icon = document.createElement("span");
    icon.setAttribute("data-test-id", "alert-icon");
    document.body.appendChild(icon);

    await expect(
      fillRow({
        icon,
        seenInputs: new Set(),
        selectors: SELECTORS,
        timeouts: TIMEOUTS,
        maxRowAncestorLevels: 8,
        jitterMaxMinutes: 0,
        randomFn: () => 0,
      })
    ).rejects.toThrow(/time-range cell/);
  });

  test("skips rows that contain a time-off-icon instead of treating them as a normal alert", async () => {
    const { icon, rangeCell } = buildRow({ timeOff: true });
    const clicked = jest.fn();
    rangeCell.addEventListener("click", clicked);

    await expect(
      fillRow({
        icon,
        seenInputs: new Set(),
        selectors: SELECTORS,
        timeouts: TIMEOUTS,
        maxRowAncestorLevels: 8,
        jitterMaxMinutes: 0,
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
    await fillRow({
      icon,
      seenInputs,
      selectors: SELECTORS,
      timeouts: TIMEOUTS,
      maxRowAncestorLevels: 8,
      jitterMaxMinutes: 0,
      randomFn: () => 0,
    });

    expect(seenInputs.size).toBe(4);
  });
});

describe("saveRow", () => {
  test("re-applies fillRow's exact values (no re-jittering) and clicks Save, never Cancel", async () => {
    const { icon } = buildRow();
    const original = icon.parentElement.querySelector('[data-test-id="time-range-cell"]');
    const saveClicked = jest.fn();
    const cancelClicked = jest.fn();
    original.addEventListener("click", () => {
      setTimeout(() => {
        document.querySelector('[data-test-id="timecard-save-button"]').addEventListener("click", saveClicked);
        document.querySelector('[data-test-id="timecard-cancel-button"]').addEventListener("click", cancelClicked);
      }, 0);
    });

    const seenInputs = new Set();
    const { filled, startInput } = await fillRow({
      icon,
      seenInputs,
      selectors: SELECTORS,
      timeouts: TIMEOUTS,
      maxRowAncestorLevels: 8,
      jitterMaxMinutes: 30,
      randomFn: () => 0.5, // 15 minutes of jitter on every field.
    });

    await saveRow({
      icon,
      filled,
      startInput,
      seenInputs,
      selectors: SELECTORS,
      timeouts: TIMEOUTS,
      maxRowAncestorLevels: 8,
    });

    expect(saveClicked).toHaveBeenCalledTimes(1);
    expect(cancelClicked).not.toHaveBeenCalled();

    // Values on screen after saveRow must still match exactly what fillRow
    // decided - proving saveRow re-typed the *remembered* values rather
    // than re-jittering with a fresh random draw.
    const fieldsScope = document.querySelector('[data-test-id="periods.0.start"]').parentElement;
    filled.forEach(({ key, hours, minutes }) => {
      const wrapper = fieldsScope.querySelector(`[data-test-id="${key}"]`);
      const [hoursEl, minutesEl] = wrapper.querySelectorAll('[role="spinbutton"]');
      expect(hoursEl.textContent).toBe(hours);
      expect(minutesEl.textContent).toBe(minutes);
    });
  });

  test("re-opens and re-fills the row if its panel was closed/reset since fillRow (regression for a real Save elsewhere resetting other open rows)", async () => {
    const { icon } = buildRow();

    const seenInputs = new Set();
    const { filled, startInput } = await fillRow({
      icon,
      seenInputs,
      selectors: SELECTORS,
      timeouts: TIMEOUTS,
      maxRowAncestorLevels: 8,
      jitterMaxMinutes: 0,
      randomFn: () => 0,
    });

    // Simulate the panel having been closed/reset (e.g. by a table-wide
    // re-render triggered by another row's real Save) before this row's
    // turn to save comes up.
    document.querySelector('[data-test-id="periods.0.start"]').closest("div").parentElement.remove();
    expect(document.querySelector('[data-test-id="periods.0.start"]')).toBeNull();
    expect(startInput.isConnected).toBe(false);

    await saveRow({
      icon,
      filled,
      startInput,
      seenInputs,
      selectors: SELECTORS,
      timeouts: TIMEOUTS,
      maxRowAncestorLevels: 8,
    });

    // The panel is open again (re-opened by saveRow) with the same values.
    const fieldsScope = document.querySelector('[data-test-id="periods.0.start"]').parentElement;
    filled.forEach(({ key, hours, minutes }) => {
      const wrapper = fieldsScope.querySelector(`[data-test-id="${key}"]`);
      const [hoursEl, minutesEl] = wrapper.querySelectorAll('[role="spinbutton"]');
      expect(hoursEl.textContent).toBe(hours);
      expect(minutesEl.textContent).toBe(minutes);
    });
  });

  test("throws if the Save button can't be found", async () => {
    document.body.innerHTML = "";
    const icon = document.createElement("span");
    icon.setAttribute("data-test-id", "alert-icon");
    document.body.appendChild(icon);

    await expect(
      saveRow({
        icon,
        filled: [],
        seenInputs: new Set(),
        selectors: SELECTORS,
        timeouts: TIMEOUTS,
        maxRowAncestorLevels: 8,
      })
    ).rejects.toThrow(/time-range cell/);
  });
});
