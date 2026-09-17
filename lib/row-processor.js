// Row-level orchestration: opens a flagged row's period-editing panel, fills
// all configured period fields, then saves (or, on a dry run, leaves it
// open) - one row at a time, start to finish, before moving on to the next.
//
// Deliberately NOT split into "fill everything, then save everything"
// batches: confirmed live, saving one row can reset/close *other* rows'
// already-open, already-filled-but-unsaved panels, so there is no way to
// safely defer Save across multiple rows on this page. Kept separate from
// content/automation.js so it can be unit tested under Jest+jsdom without
// pulling in chrome.* or the onMessage wiring.
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
  //
  // Never trust that this worked just because nothing threw: the
  // click/focus/execCommand sequence can silently no-op (stale focus, a
  // mid-flight re-render swapping the node, etc.), leaving the segment
  // showing its old value while the rest of the row carries on as if it had
  // been filled correctly. So we read the segment back after each attempt
  // and retry a few times before giving up loudly instead of proceeding
  // with unverified (possibly wrong or empty) data.
  async function typeIntoSegment(el, text, typeCharDelayMs, maxAttempts = 3) {
    const target = String(text);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (!el.isConnected) {
        throw new Error(
          `segment (aria-label="${el.getAttribute("aria-label") || "?"}") was removed from the page before "${target}" could be typed into it`
        );
      }

      simulateClick(el);
      el.focus();

      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, target);
      el.dispatchEvent(
        new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: target })
      );

      await sleep(typeCharDelayMs);

      el.blur();
      el.dispatchEvent(new Event("blur", { bubbles: true }));

      if (el.textContent === target) return;
    }

    throw new Error(
      `segment (aria-label="${el.getAttribute("aria-label") || "?"}") still shows "${el.textContent}" instead of "${target}" after ${maxAttempts} attempt(s)`
    );
  }

  async function fillTimeField(el, value, jitterMaxMinutes, typeCharDelayMs, randomFn) {
    const parts = jitterValue(value, jitterMaxMinutes, randomFn);

    const { hours } = getTimeSegments(el);
    if (!hours) throw new Error("no hours/minutes spinbutton segments found");
    await typeIntoSegment(hours, parts.hours, typeCharDelayMs);

    // Re-fetch minutes fresh from the same wrapper *after* typing hours,
    // instead of reusing a reference captured before that: confirmed live,
    // typing into hours can make the framework re-render and swap in a new
    // DOM node for the sibling minutes segment while `el` (the field's
    // wrapper) stays the same - silently detaching whatever we grabbed
    // upfront ("segment ... minutes ... was removed from the page", right
    // after hours had just been typed successfully).
    const { minutes } = getTimeSegments(el);
    if (minutes) {
      await typeIntoSegment(minutes, parts.minutes, typeCharDelayMs);
    }
    return parts;
  }

  // Processes a single flagged row end to end: opens its panel, fills all 4
  // period fields, then saves (or, on a dry run, stops here and leaves the
  // panel open with the filled-but-unsaved values visible for inspection -
  // never clicking Save or Cancel).
  //
  // Fields are re-queried from `scope` immediately before each fill rather
  // than resolved once upfront, because the framework can re-render and
  // swap in new DOM nodes for not-yet-filled fields partway through a row:
  // confirmed live, a stale reference to a later field silently no-ops
  // (it's simply detached) instead of throwing, which is what caused "only
  // the first field/row gets filled" in practice.
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
    const filledElements = [];
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
      filledElements.push(freshEl);
    }

    // Safety net for a live anomaly (cause not fully understood - we never
    // click or otherwise touch a "+ Work"/"+ Break" button anywhere in this
    // file, so this isn't us pressing it; more likely some Personio-side
    // validation/suggestion behavior reacting to the values or edit
    // sequence): occasionally an *extra* (3rd) period shows up in the row
    // beyond the two we configured, leaving the day with overlapping/
    // invalid periods ("Periods can't overlap"). One recovery attempt: click
    // that extra period's own delete button (confirmed live, it's always
    // the 3rd/last one) and re-check. If that doesn't bring the count back
    // to normal, give up loudly rather than risk saving (or, on a dry run,
    // leaving open and reporting as "fixed") a row that's still corrupted.
    const countPeriodFields = () => scope.querySelectorAll('[data-test-id^="periods."]').length;
    if (countPeriodFields() !== selectors.PERIODS.length) {
      const deleteExtraButton = selectors.DELETE_EXTRA_PERIOD_BUTTON
        ? scope.querySelector(selectors.DELETE_EXTRA_PERIOD_BUTTON)
        : null;
      if (deleteExtraButton) {
        simulateClick(deleteExtraButton);
        await waitFor(() => countPeriodFields() === selectors.PERIODS.length, timeouts.WAIT_FOR_ROW_INPUTS_MS, timeouts.POLL_INTERVAL_MS);
      }

      const countAfterRecovery = countPeriodFields();
      if (countAfterRecovery !== selectors.PERIODS.length) {
        const reason = deleteExtraButton
          ? `clicking its delete button (${selectors.DELETE_EXTRA_PERIOD_BUTTON}) did not fix it`
          : `its delete button (${selectors.DELETE_EXTRA_PERIOD_BUTTON}) could not be found`;
        throw new Error(
          `expected exactly ${selectors.PERIODS.length} period fields but found ${countAfterRecovery} - an extra period appeared and ${reason}, refusing to touch a possibly-corrupted day`
        );
      }
    }

    // Dry run: deliberately do nothing here - no Save, no Cancel - and just
    // leave the panel open with the filled-but-unsaved values so they're
    // visible for inspection and nothing is written or discarded.
    if (dryRun) {
      return { filled };
    }

    // Search from `newStartInput` again (not the narrower `scope`) since
    // Save lives in the form's footer, outside the smallest ancestor that
    // wraps just the 4 period fields.
    const formScope = findRowScope(newStartInput, [selectors.SAVE_BUTTON], maxRowAncestorLevels + 4);
    const saveButton = formScope ? formScope.querySelector(selectors.SAVE_BUTTON) : null;
    if (!saveButton) {
      throw new Error("could not find the Save button for this row");
    }
    simulateClick(saveButton);

    // Confirmed live: Save doesn't remove this row's fields from the DOM
    // synchronously - it exits via an animation (Personio's row carries
    // `--animate-presence-transition-duration-in-ms: 0.36`, i.e. a ~360ms
    // framer-motion exit), and being an actual persist, can also trigger a
    // broader re-render of the whole table's summary data. Wait for ALL 4
    // fields we filled to actually leave the DOM - not just the first one
    // (`newStartInput`) - before moving on: a partial re-render can detach
    // just one of them while the other 3 (and the panel as a whole) are
    // still visibly open, which made checking only the first field close
    // the loop early and open the *next* row while this one was still on
    // screen ("several rows open at once"). Treat "never fully disappeared"
    // as a real failure (we can't confirm the save actually went through)
    // rather than silently moving on.
    const disappeared = await waitFor(
      () => filledElements.every((el) => !el.isConnected),
      timeouts.WAIT_FOR_ROW_INPUTS_MS,
      timeouts.POLL_INTERVAL_MS
    );
    if (!disappeared) {
      throw new Error("row fields did not disappear after Save - could not confirm it was actually saved");
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
