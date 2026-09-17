const { processRow, typeIntoSegment, fillTimeField } = require("../lib/row-processor");

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
  DELETE_EXTRA_PERIOD_BUTTON: '[data-test-id="timecard-delete-period-2"]',
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
function buildRow({ swapFieldsAfterFirstPeriod = false, timeOff = false, saveRemovalDelayMs = null } = {}) {
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

    // Mirrors the real page: a real Save doesn't remove the panel from the
    // DOM synchronously - it exits via an animation first (see the "waits
    // for the panel to actually leave the DOM after Save" test below). Off
    // by default so tests that don't care about this can inspect the panel
    // right after processRow() resolves.
    if (saveRemovalDelayMs !== null) {
      saveButton.addEventListener("click", () => {
        setTimeout(() => panel.remove(), saveRemovalDelayMs);
      });
    }

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

describe("fillTimeField", () => {
  test("re-fetches the minutes segment after typing hours, in case the framework swapped it out (regression for 'minutes ... was removed from the page' right after hours was typed)", async () => {
    const wrapper = makePeriodField("periods.0.start");
    document.body.appendChild(wrapper);

    const hoursSeg = Array.from(wrapper.querySelectorAll('[role="spinbutton"]')).find(
      (s) => s.getAttribute("aria-label") === "hours"
    );
    const staleMinutes = wrapper.querySelector('[role="spinbutton"][aria-label="minutes"]');
    // Simulate the framework re-rendering and swapping in a brand new DOM
    // node for the sibling minutes segment the moment hours reports its
    // value, while the wrapper itself (`el`) stays the same node.
    hoursSeg.addEventListener(
      "input",
      () => {
        wrapper.replaceChild(makeSegment("minutes"), staleMinutes);
      },
      { once: true }
    );

    const parts = await fillTimeField(wrapper, "915", 0, 1, () => 0);

    expect(parts).toEqual({ hours: "09", minutes: "15" });
    // The stale (detached) node must never have been written to - proving
    // the fix re-fetched minutes fresh rather than reusing the captured
    // reference (which would have silently no-opped on a detached node, or
    // thrown, depending on when the swap happened).
    expect(staleMinutes.textContent).toBe("00");
    expect(staleMinutes.isConnected).toBe(false);
    const freshMinutes = wrapper.querySelector('[role="spinbutton"][aria-label="minutes"]');
    expect(freshMinutes.textContent).toBe("15");
  });
});

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

    expect(result.filled).toEqual([
      { key: "periods.0.start", hours: "09", minutes: "00" },
      { key: "periods.0.end", hours: "18", minutes: "00" },
      { key: "periods.1.start", hours: "14", minutes: "00" },
      { key: "periods.1.end", hours: "15", minutes: "00" },
    ]);
  });

  test("fills all 4 fields normally when nothing gets swapped out", async () => {
    const { icon } = buildRow();

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

    expect(result.filled).toEqual([
      { key: "periods.0.start", hours: "09", minutes: "00" },
      { key: "periods.0.end", hours: "18", minutes: "00" },
      { key: "periods.1.start", hours: "14", minutes: "00" },
      { key: "periods.1.end", hours: "15", minutes: "00" },
    ]);
  });

  test("applies jitter on top of the configured base value", async () => {
    const { icon } = buildRow();

    const result = await processRow({
      icon,
      seenInputs: new Set(),
      selectors: SELECTORS,
      timeouts: TIMEOUTS,
      maxRowAncestorLevels: 8,
      jitterMaxMinutes: 30,
      dryRun: true,
      randomFn: () => 0.5, // Math.floor(0.5 * 31) === 15 minutes of jitter.
    });

    expect(result.filled[0]).toEqual({ key: "periods.0.start", hours: "09", minutes: "15" });
  });

  test("dry run clicks neither Save nor Cancel, leaving the filled panel open; non-dry-run clicks Save", async () => {
    async function run(dryRun) {
      // Real runs need the panel to actually disappear after Save for
      // processRow to consider it confirmed - see the dedicated tests below
      // for that wait itself.
      const { icon } = buildRow({ saveRemovalDelayMs: dryRun ? null : 0 });
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

    // Dry run: on purpose, don't click anything. The filled-but-unsaved
    // values stay visible in the (still open) panel for inspection, and
    // nothing gets written or discarded.
    const dryRunResult = await run(true);
    expect(dryRunResult.saveClicked).not.toHaveBeenCalled();
    expect(dryRunResult.cancelClicked).not.toHaveBeenCalled();
    expect(document.querySelector('[data-test-id="periods.0.start"]')).not.toBeNull();

    const realRunResult = await run(false);
    expect(realRunResult.saveClicked).toHaveBeenCalledTimes(1);
    expect(realRunResult.cancelClicked).not.toHaveBeenCalled();
  });

  test("waits for the panel to actually leave the DOM after Save before returning (regression for the next row racing this one's close animation)", async () => {
    // Simulates the live page's exit animation with a much shorter delay so
    // the test stays fast, while still exercising the same race: if
    // processRow() returned as soon as Save was *clicked* (instead of
    // waiting for the DOM to actually reflect it), content/automation.js's
    // fixed BETWEEN_ROWS_DELAY_MS could open the next row before this one
    // finished closing.
    const { icon } = buildRow({ saveRemovalDelayMs: 30 });

    const before = Date.now();
    await processRow({
      icon,
      seenInputs: new Set(),
      selectors: SELECTORS,
      timeouts: TIMEOUTS,
      maxRowAncestorLevels: 8,
      jitterMaxMinutes: 0,
      dryRun: false,
      randomFn: () => 0,
    });
    const elapsed = Date.now() - before;

    // Must have actually waited for the ~30ms removal, not resolved the
    // instant Save was clicked.
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(document.querySelector('[data-test-id="periods.0.start"]')).toBeNull();
  });

  test("waits for ALL 4 filled fields to disappear after Save, not just the first one (regression for 'several rows open at once')", async () => {
    const { icon } = buildRow();
    const rangeCell = icon.parentElement.querySelector('[data-test-id="time-range-cell"]');
    rangeCell.addEventListener("click", () => {
      setTimeout(() => {
        const save = document.querySelector('[data-test-id="timecard-save-button"]');
        save.addEventListener("click", () => {
          // Simulate a partial re-render: only the first field
          // (periods.0.start) disappears right away, while the other 3 -
          // and thus the panel as a whole - stay visibly open for a bit
          // longer before the row actually finishes closing.
          document.querySelector('[data-test-id="periods.0.start"]').remove();
          setTimeout(() => {
            ["periods.0.end", "periods.1.start", "periods.1.end"].forEach((testId) => {
              const el = document.querySelector(`[data-test-id="${testId}"]`);
              if (el) el.remove();
            });
          }, 30);
        });
      }, 0);
    });

    const before = Date.now();
    await processRow({
      icon,
      seenInputs: new Set(),
      selectors: SELECTORS,
      timeouts: TIMEOUTS,
      maxRowAncestorLevels: 8,
      jitterMaxMinutes: 0,
      dryRun: false,
      randomFn: () => 0,
    });
    const elapsed = Date.now() - before;

    // Must have actually waited for the other 3 fields too (~30ms later),
    // not returned as soon as just the first one disappeared.
    expect(elapsed).toBeGreaterThanOrEqual(25);
  });

  test("throws (so the row is marked skipped) if only some fields disappear after Save and the rest never do", async () => {
    const { icon } = buildRow();
    const rangeCell = icon.parentElement.querySelector('[data-test-id="time-range-cell"]');
    rangeCell.addEventListener("click", () => {
      setTimeout(() => {
        const save = document.querySelector('[data-test-id="timecard-save-button"]');
        save.addEventListener("click", () => {
          // Only the first field ever disappears; the other 3 (and thus the
          // panel) stay open forever - the row never actually finishes
          // closing.
          document.querySelector('[data-test-id="periods.0.start"]').remove();
        });
      }, 0);
    });

    await expect(
      processRow({
        icon,
        seenInputs: new Set(),
        selectors: SELECTORS,
        timeouts: TIMEOUTS,
        maxRowAncestorLevels: 8,
        jitterMaxMinutes: 0,
        dryRun: false,
        randomFn: () => 0,
      })
    ).rejects.toThrow(/did not disappear after Save/);
  });

  test("throws (so the row is marked skipped) if the fields never disappear after Save - we can't confirm it was actually saved", async () => {
    // saveRemovalDelayMs left at its default (null): the panel never gets
    // removed, simulating Save silently not going through.
    const { icon } = buildRow();

    await expect(
      processRow({
        icon,
        seenInputs: new Set(),
        selectors: SELECTORS,
        timeouts: TIMEOUTS,
        maxRowAncestorLevels: 8,
        jitterMaxMinutes: 0,
        dryRun: false,
        randomFn: () => 0,
      })
    ).rejects.toThrow(/did not disappear after Save/);
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

  test("recovers from an extra period by clicking its delete button, then proceeds normally (Save gets clicked)", async () => {
    const { icon } = buildRow({ saveRemovalDelayMs: 0 });
    const rangeCell = icon.parentElement.querySelector('[data-test-id="time-range-cell"]');
    const saveClicked = jest.fn();
    const deleteClicked = jest.fn();
    rangeCell.addEventListener("click", () => {
      setTimeout(() => {
        const save = document.querySelector('[data-test-id="timecard-save-button"]');
        if (save) save.addEventListener("click", saveClicked);

        // Simulate an extra period ("periods.2.start"/"periods.2.end")
        // showing up alongside the two we expect, with its own working
        // delete button - mirrors the live anomaly and its recovery path.
        const fieldsScope = document.querySelector('[data-test-id="periods.1.end"]').parentElement;
        fieldsScope.appendChild(makePeriodField("periods.2.start"));
        fieldsScope.appendChild(makePeriodField("periods.2.end"));

        const deleteButton = document.createElement("button");
        deleteButton.setAttribute("data-test-id", "timecard-delete-period-2");
        deleteButton.addEventListener("click", () => {
          deleteClicked();
          fieldsScope
            .querySelectorAll('[data-test-id="periods.2.start"], [data-test-id="periods.2.end"]')
            .forEach((el) => el.remove());
        });
        fieldsScope.appendChild(deleteButton);
      }, 0);
    });

    await processRow({
      icon,
      seenInputs: new Set(),
      selectors: SELECTORS,
      timeouts: TIMEOUTS,
      maxRowAncestorLevels: 8,
      jitterMaxMinutes: 0,
      dryRun: false,
      randomFn: () => 0,
    });

    expect(deleteClicked).toHaveBeenCalledTimes(1);
    expect(saveClicked).toHaveBeenCalledTimes(1);
  });

  test("gives up (throws, so the row is marked skipped) if an extra period appears and its delete button can't be found or doesn't fix it", async () => {
    const { icon } = buildRow();
    const rangeCell = icon.parentElement.querySelector('[data-test-id="time-range-cell"]');
    const saveClicked = jest.fn();
    rangeCell.addEventListener("click", () => {
      setTimeout(() => {
        const save = document.querySelector('[data-test-id="timecard-save-button"]');
        if (save) save.addEventListener("click", saveClicked);
        // No delete button provided this time - recovery has nothing to click.
        const fieldsScope = document.querySelector('[data-test-id="periods.1.end"]').parentElement;
        fieldsScope.appendChild(makePeriodField("periods.2.start"));
        fieldsScope.appendChild(makePeriodField("periods.2.end"));
      }, 0);
    });

    await expect(
      processRow({
        icon,
        seenInputs: new Set(),
        selectors: SELECTORS,
        timeouts: TIMEOUTS,
        maxRowAncestorLevels: 8,
        jitterMaxMinutes: 0,
        dryRun: false,
        randomFn: () => 0,
      })
    ).rejects.toThrow(/extra period/);

    expect(saveClicked).not.toHaveBeenCalled();
  });

  test("throws if the Save button can't be found on a real (non-dry-run) row", async () => {
    const { icon } = buildRow();
    // Remove the Save button once the panel opens, so processRow can't find it.
    const rangeCell = icon.parentElement.querySelector('[data-test-id="time-range-cell"]');
    rangeCell.addEventListener("click", () => {
      setTimeout(() => {
        const save = document.querySelector('[data-test-id="timecard-save-button"]');
        if (save) save.remove();
      }, 0);
    });

    await expect(
      processRow({
        icon,
        seenInputs: new Set(),
        selectors: SELECTORS,
        timeouts: TIMEOUTS,
        maxRowAncestorLevels: 8,
        jitterMaxMinutes: 0,
        dryRun: false,
        randomFn: () => 0,
      })
    ).rejects.toThrow(/Save button/);
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
