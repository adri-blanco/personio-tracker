// Row-level orchestration: opens a flagged row's period-editing panel, fills
// all configured period fields, then saves or (dry-run) cancels. Kept
// separate from content/automation.js so it can be unit tested under
// Jest+jsdom without pulling in chrome.* or the onMessage wiring.
(function (global) {
  const domUtils = typeof module !== "undefined" && module.exports ? require("./dom-utils") : global.PersonioDomUtils;
  const timeUtils = typeof module !== "undefined" && module.exports ? require("./time-utils") : global.PersonioTimeUtils;

  const {
    waitFor,
    waitForNewElement,
    findRowScope,
    isTimeOffRow,
    simulateClick,
    getTimeSegments,
    resolveRowElements,
    sleep,
  } = domUtils;
  const { jitterValue } = timeUtils;

  // Verified against the live page: this component's `beforeinput`/keydown
  // handling blocks plain synthetic KeyboardEvents (dispatching keydown
  // alone never changes the text). What actually works is triggering a
  // real edit via `document.execCommand`, which performs a genuine
  // contenteditable mutation, followed by a synthetic `input` event so the
  // framework's controlled-value listener picks up the new text.
  async function typeIntoSegment(el, text, typeCharDelayMs) {
    simulateClick(el);
    el.focus();

    document.execCommand("selectAll", false, null);
    document.execCommand("insertText", false, String(text));
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: String(text) })
    );

    await sleep(typeCharDelayMs);

    el.blur();
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  async function fillTimeField(el, value, jitterMaxMinutes, typeCharDelayMs, randomFn) {
    const { hours, minutes } = getTimeSegments(el);
    if (!hours) throw new Error("no hours/minutes spinbutton segments found");

    const parts = jitterValue(value, jitterMaxMinutes, randomFn);
    await typeIntoSegment(hours, parts.hours, typeCharDelayMs);
    if (minutes) {
      await typeIntoSegment(minutes, parts.minutes, typeCharDelayMs);
    }
    return parts;
  }

  // Processes a single flagged row. Fields are re-queried from `scope`
  // immediately before each fill rather than resolved once upfront, because
  // the framework can re-render and swap in new DOM nodes for not-yet-filled
  // fields partway through a row: confirmed live, a stale reference to a
  // later field silently no-ops (it's simply detached) instead of throwing,
  // which is what caused "only the first field/row gets filled" in practice.
  async function processRow({ icon, seenInputs, selectors, timeouts, maxRowAncestorLevels, jitterMaxMinutes, dryRun, randomFn }) {
    const row = findRowScope(icon, [selectors.TIME_RANGE_CELL], maxRowAncestorLevels);
    const rangeCell = row ? row.querySelector(selectors.TIME_RANGE_CELL) : null;
    if (!rangeCell) {
      throw new Error("could not find the time-range cell for this row");
    }
    // Safety net: content/automation.js already filters time-off rows out of
    // its snapshot before this ever runs, but re-check here in case the DOM
    // shifted between that snapshot and this click.
    if (isTimeOffRow(icon, selectors, maxRowAncestorLevels)) {
      throw new Error("row is a time-off row (has a time-off-icon), skipping");
    }
    if (rangeCell.scrollIntoView) rangeCell.scrollIntoView({ block: "center" });
    simulateClick(rangeCell);

    const startSelector = selectors.PERIODS[0].selector;
    const newStartInput = await waitForNewElement(
      startSelector,
      seenInputs,
      timeouts.WAIT_FOR_ROW_INPUTS_MS,
      timeouts.POLL_INTERVAL_MS
    );
    if (!newStartInput) {
      throw new Error("period inputs did not appear");
    }

    const periodSelectors = selectors.PERIODS.map((p) => p.selector);
    const resolved = await resolveRowElements(
      newStartInput,
      periodSelectors,
      maxRowAncestorLevels,
      timeouts.WAIT_FOR_ROW_INPUTS_MS,
      timeouts.POLL_INTERVAL_MS
    );
    if (!resolved) {
      throw new Error("could not resolve all 4 period inputs for this row");
    }
    const { scope } = resolved;

    const filled = [];
    for (const period of selectors.PERIODS) {
      const freshEl = await waitFor(
        () => scope.querySelector(period.selector),
        timeouts.WAIT_FOR_ROW_INPUTS_MS,
        timeouts.POLL_INTERVAL_MS
      );
      if (!freshEl) {
        throw new Error(`"${period.key}" field disappeared before it could be filled`);
      }
      const parts = await fillTimeField(freshEl, period.value, jitterMaxMinutes, timeouts.TYPE_CHAR_DELAY_MS, randomFn);
      seenInputs.add(freshEl);
      filled.push({ key: period.key, ...parts });
    }

    // The typed values only persist once Save is clicked (confirmed live:
    // filling and blurring fields never sends a save request on its own).
    // Search from `newStartInput` again (not the narrower `scope`) since
    // Save/Cancel live in the form's footer, outside the smallest ancestor
    // that wraps just the 4 period fields.
    if (dryRun) {
      const cancelScope = findRowScope(newStartInput, [selectors.CANCEL_BUTTON], maxRowAncestorLevels + 4);
      const cancelButton = cancelScope ? cancelScope.querySelector(selectors.CANCEL_BUTTON) : null;
      // Clicking Cancel (rather than just leaving the panel open) keeps dry
      // runs from leaving unsaved edits sitting around indefinitely.
      if (cancelButton) {
        simulateClick(cancelButton);
      }
    } else {
      const formScope = findRowScope(newStartInput, [selectors.SAVE_BUTTON], maxRowAncestorLevels + 4);
      const saveButton = formScope ? formScope.querySelector(selectors.SAVE_BUTTON) : null;
      if (!saveButton) {
        throw new Error("could not find the Save button for this row");
      }
      simulateClick(saveButton);
      await sleep(timeouts.WAIT_FOR_ROW_INPUTS_MS);
    }

    return { filled };
  }

  const api = { typeIntoSegment, fillTimeField, processRow };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.PersonioRowProcessor = api;
  }
})(typeof self !== "undefined" ? self : globalThis);
