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

  // Types exact, pre-decided hours/minutes strings into a period field's two
  // segments (no jitter/randomization - used to (re)apply a value that was
  // already decided earlier, e.g. by fillTimeField during the fill phase).
  async function typeExactTimeField(el, hours, minutes, typeCharDelayMs) {
    const segs = getTimeSegments(el);
    if (!segs.hours) throw new Error("no hours/minutes spinbutton segments found");
    await typeIntoSegment(segs.hours, hours, typeCharDelayMs);
    if (segs.minutes) {
      await typeIntoSegment(segs.minutes, minutes, typeCharDelayMs);
    }
  }

  async function fillTimeField(el, value, jitterMaxMinutes, typeCharDelayMs, randomFn) {
    const parts = jitterValue(value, jitterMaxMinutes, randomFn);
    await typeExactTimeField(el, parts.hours, parts.minutes, typeCharDelayMs);
    return parts;
  }

  // Clicks a flagged row's time-range cell to open its panel and resolves
  // its 4 period-field elements, waiting for each to actually appear/settle.
  // Fields are re-queried from `scope` immediately before each use rather
  // than resolved once upfront, because the framework can re-render and
  // swap in new DOM nodes for not-yet-touched fields partway through a row:
  // confirmed live, a stale reference to a later field silently no-ops
  // (it's simply detached) instead of throwing, which is what caused "only
  // the first field/row gets filled" in practice.
  //
  // Note there's no reliable DOM link between a row's icon/time-range-cell
  // and the panel this opens: on the real page (mirrored by the test
  // fixtures) the panel is a separate subtree, not a descendant of the row,
  // appended asynchronously after the click. So "is this row's panel
  // already open" can only be answered by the caller checking connectivity
  // on the exact `newStartInput` reference a previous call returned - see
  // saveRow below - never by searching for it under the row itself.
  async function openRowScope(icon, seenInputs, selectors, timeouts, maxRowAncestorLevels) {
    const row = findRowScope(icon, [selectors.TIME_RANGE_CELL], maxRowAncestorLevels);
    const rangeCell = row ? row.querySelector(selectors.TIME_RANGE_CELL) : null;
    if (!rangeCell) {
      throw new Error("could not find the time-range cell for this row");
    }

    if (rangeCell.scrollIntoView) rangeCell.scrollIntoView({ block: "center" });
    simulateClick(rangeCell);

    const startSelector = selectors.PERIODS[0].selector;
    const newStartInput = await waitForNewElement(startSelector, seenInputs, timeouts.WAIT_FOR_ROW_INPUTS_MS, timeouts.POLL_INTERVAL_MS);
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

    return { newStartInput, scope: resolved.scope };
  }

  // Phase 1: opens a flagged row's panel and fills all 4 period fields with
  // a freshly-jittered value, but never clicks Save (or Cancel). Returns the
  // exact values typed - so a later saveRow() call can re-apply the very
  // same values instead of re-jittering, keeping what's on screen now
  // consistent with what eventually gets saved - plus the `startInput`
  // element reference saveRow needs to detect whether this same panel is
  // still open by the time it's this row's turn to be saved.
  async function fillRow({ icon, seenInputs, selectors, timeouts, maxRowAncestorLevels, jitterMaxMinutes, randomFn }) {
    // Safety net: content/automation.js already filters time-off rows out of
    // its snapshot before this ever runs, but re-check here in case the DOM
    // shifted between that snapshot and this click.
    if (isTimeOffRow(icon, selectors, maxRowAncestorLevels)) {
      throw new Error("row is a time-off row (has a time-off-icon), skipping");
    }

    const { newStartInput, scope } = await openRowScope(icon, seenInputs, selectors, timeouts, maxRowAncestorLevels);

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

    return { filled, startInput: newStartInput };
  }

  // Phase 2: saves a row that fillRow() already filled. Re-applies the
  // exact `filled` values before clicking Save - a deliberate safety net,
  // not just belt-and-braces: saving one row can make Personio re-render
  // the whole table (same root cause documented in content/automation.js
  // for stale alert-icon references), which can reset another row's
  // already-open, already-filled panel back to closed/blank in the process.
  // `startInput` (from fillRow) tells us whether that happened: if it's
  // still connected, the panel is still open and we just re-verify/re-type
  // into it; if not, we reopen the row from scratch before re-filling. Cheap
  // either way, and guarantees we never save a blank/reset field.
  async function saveRow({ icon, filled, startInput, seenInputs, selectors, timeouts, maxRowAncestorLevels }) {
    const stillOpen = startInput && startInput.isConnected;
    const { newStartInput, scope } = stillOpen
      ? await resolveRowElements(
          startInput,
          selectors.PERIODS.map((p) => p.selector),
          maxRowAncestorLevels,
          timeouts.WAIT_FOR_ROW_INPUTS_MS,
          timeouts.POLL_INTERVAL_MS
        ).then((resolved) => {
          if (!resolved) throw new Error("could not resolve all 4 period inputs for this row before saving");
          return { newStartInput: startInput, scope: resolved.scope };
        })
      : await openRowScope(icon, seenInputs, selectors, timeouts, maxRowAncestorLevels);

    for (const period of selectors.PERIODS) {
      const target = filled.find((f) => f.key === period.key);
      if (!target) continue;
      const freshEl = await waitFor(
        () => scope.querySelector(period.selector),
        timeouts.WAIT_FOR_ROW_INPUTS_MS,
        timeouts.POLL_INTERVAL_MS
      );
      if (!freshEl) {
        throw new Error(`"${period.key}" field disappeared before it could be saved`);
      }
      await typeExactTimeField(freshEl, target.hours, target.minutes, timeouts.TYPE_CHAR_DELAY_MS);
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
    // A real Save can trigger the same kind of exit animation Personio uses
    // elsewhere (confirmed live: a ~360ms AnimatePresence exit that keeps
    // the row's DOM mounted until it finishes), plus - being an actual
    // persist - a server round-trip that can drive a broader re-render of
    // the whole table's summary data. The batch-save loop's fixed
    // BETWEEN_SAVES_DELAY_MS (1s) is a reasonable throttle for the Save
    // endpoint itself, but isn't guaranteed to outlast whatever that
    // resulting re-render takes, so without this wait the next queued
    // row's reopen can land mid-flight and its own fields go stale before
    // we finish resolving them - surfacing as a seemingly random row being
    // skipped ("period inputs did not appear" / "could not resolve all 4
    // period inputs") in the middle of an otherwise-successful batch. Wait
    // for this row's own fields to actually leave the DOM instead of
    // guessing a fixed delay, so we're robust regardless of how long that
    // takes.
    await waitFor(() => !newStartInput.isConnected, timeouts.WAIT_FOR_ROW_INPUTS_MS, timeouts.POLL_INTERVAL_MS);
  }

  const api = { typeIntoSegment, fillTimeField, fillRow, saveRow };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.PersonioRowProcessor = api;
  }
})(typeof self !== "undefined" ? self : globalThis);
