// DOM helpers shared by content/automation.js. Depends only on standard
// DOM/browser globals (document, MouseEvent, etc.), never on chrome.* or
// CONFIG, so it works unmodified as a content script and under Jest+jsdom.
(function (global) {
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Polls `predicate` until it returns a truthy value or `timeoutMs` elapses.
  function waitFor(predicate, timeoutMs, pollMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const result = predicate();
        if (result) {
          resolve(result);
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          resolve(null);
          return;
        }
        setTimeout(tick, pollMs);
      };
      tick();
    });
  }

  function waitForElement(selector, timeoutMs, pollMs) {
    return waitFor(() => document.querySelector(selector), timeoutMs, pollMs);
  }

  // Waits for a selector match that isn't already in `seen` (used so that
  // rows expanded by earlier iterations, which stay in the DOM, aren't
  // mistaken for the row we just clicked).
  function waitForNewElement(selector, seen, timeoutMs, pollMs) {
    return waitFor(() => {
      const candidates = document.querySelectorAll(selector);
      for (const el of candidates) {
        if (!seen.has(el)) return el;
      }
      return null;
    }, timeoutMs, pollMs);
  }

  // Walks up from `anchorEl` looking for the smallest ancestor that also
  // contains all of `requiredSelectors`.
  function findRowScope(anchorEl, requiredSelectors, maxLevels) {
    let node = anchorEl.parentElement;
    for (let level = 0; level < maxLevels && node; level += 1) {
      const hasAll = requiredSelectors.every((sel) => node.querySelector(sel));
      if (hasAll) return node;
      node = node.parentElement;
    }
    return null;
  }

  // Dispatches a full mouse event sequence instead of calling el.click(),
  // because SVG elements (common for icon markup) don't implement
  // HTMLElement's click() method and would throw "click is not a function".
  function simulateClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: global.window || global, clientX: x, clientY: y };
    el.dispatchEvent(new MouseEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  // The period fields are NOT native inputs. They're pairs of contenteditable
  // <span role="spinbutton" aria-label="hours|minutes"> segments (a
  // "TimeInput" component). `el` (matched by the periods.*.start/end
  // selector) may be one of those segments directly, or a wrapper around
  // both. Either way, find the hours/minutes segment pair to interact with.
  function getTimeSegments(el) {
    if (!el) return {};
    const isSegment = el.getAttribute && el.getAttribute("role") === "spinbutton";
    const scope = isSegment ? el.closest('[role="group"]') || el.parentElement : el;
    const segments = Array.from(scope.querySelectorAll('[role="spinbutton"]'));
    const byLabel = (substr) =>
      segments.find((s) => (s.getAttribute("aria-label") || "").toLowerCase().includes(substr));

    return {
      hours: byLabel("hour") || segments[0] || (isSegment ? el : null),
      minutes: byLabel("minute") || segments[1] || null,
    };
  }

  // Finds the smallest ancestor of `anchorEl` that contains all 4 period
  // selectors, then resolves each of them within that ancestor. Returns
  // `{ scope, elements }` (where `elements` is only a same-moment snapshot -
  // callers that fill fields one at a time should re-query from `scope`
  // right before each interaction rather than trusting this snapshot, since
  // the framework may re-render and replace sibling nodes mid-row) or `null`
  // if the row never fully appears within `timeoutMs`.
  async function resolveRowElements(anchorEl, periodSelectors, maxLevels, timeoutMs, pollMs) {
    const scope = await waitFor(
      () => findRowScope(anchorEl, periodSelectors, maxLevels),
      timeoutMs,
      pollMs
    );

    if (!scope) return null;

    const elements = periodSelectors.map((sel) => scope.querySelector(sel));
    const missing = elements.some((el) => !el);
    return missing ? null : { scope, elements };
  }

  const api = {
    sleep,
    waitFor,
    waitForElement,
    waitForNewElement,
    findRowScope,
    simulateClick,
    getTimeSegments,
    resolveRowElements,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.PersonioDomUtils = api;
  }
})(typeof self !== "undefined" ? self : globalThis);
