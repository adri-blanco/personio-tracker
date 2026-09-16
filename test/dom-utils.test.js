const {
  waitFor,
  waitForElement,
  waitForNewElement,
  findRowScope,
  isTimeOffRow,
  simulateClick,
  getTimeSegments,
  resolveRowElements,
} = require("../lib/dom-utils");

describe("waitFor", () => {
  test("resolves as soon as the predicate becomes truthy", async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 20);

    const result = await waitFor(() => (ready ? "yes" : null), 500, 10);
    expect(result).toBe("yes");
  });

  test("resolves null once the timeout elapses without the predicate becoming truthy", async () => {
    const result = await waitFor(() => null, 60, 10);
    expect(result).toBeNull();
  });
});

describe("waitForElement", () => {
  test("finds an element already in the DOM", async () => {
    document.body.innerHTML = '<div id="target"></div>';
    const el = await waitForElement("#target", 200, 10);
    expect(el).toBe(document.getElementById("target"));
  });

  test("finds an element that appears after a delay", async () => {
    document.body.innerHTML = "";
    setTimeout(() => {
      document.body.innerHTML = '<div id="late"></div>';
    }, 20);

    const el = await waitForElement("#late", 500, 10);
    expect(el).not.toBeNull();
    expect(el.id).toBe("late");
  });

  test("returns null when the element never appears", async () => {
    document.body.innerHTML = "";
    const el = await waitForElement("#missing", 60, 10);
    expect(el).toBeNull();
  });
});

describe("waitForNewElement", () => {
  test("ignores already-seen elements and only returns a new match", async () => {
    document.body.innerHTML = '<div class="row">old</div>';
    const oldEl = document.querySelector(".row");
    const seen = new Set([oldEl]);

    setTimeout(() => {
      const fresh = document.createElement("div");
      fresh.className = "row";
      fresh.textContent = "new";
      document.body.appendChild(fresh);
    }, 20);

    const found = await waitForNewElement(".row", seen, 500, 10);
    expect(found).not.toBeNull();
    expect(found.textContent).toBe("new");
    expect(found).not.toBe(oldEl);
  });

  test("returns null if only already-seen elements exist", async () => {
    document.body.innerHTML = '<div class="row">old</div>';
    const oldEl = document.querySelector(".row");
    const seen = new Set([oldEl]);

    const found = await waitForNewElement(".row", seen, 60, 10);
    expect(found).toBeNull();
  });
});

describe("findRowScope", () => {
  test("returns the smallest ancestor containing all required selectors", () => {
    document.body.innerHTML = `
      <div id="outer">
        <div id="middle">
          <div id="icon-wrapper"><span data-test-id="alert-icon"></span></div>
          <div data-test-id="time-range-cell"></div>
        </div>
        <div data-test-id="unrelated"></div>
      </div>
    `;
    const icon = document.querySelector('[data-test-id="alert-icon"]');
    const scope = findRowScope(icon, ['[data-test-id="time-range-cell"]'], 8);
    expect(scope).toBe(document.getElementById("middle"));
  });

  test("returns null when no ancestor within maxLevels contains all selectors", () => {
    document.body.innerHTML = `
      <div>
        <div><div><span data-test-id="alert-icon"></span></div></div>
        <div data-test-id="time-range-cell"></div>
      </div>
    `;
    const icon = document.querySelector('[data-test-id="alert-icon"]');
    const scope = findRowScope(icon, ['[data-test-id="time-range-cell"]'], 1);
    expect(scope).toBeNull();
  });
});

describe("isTimeOffRow", () => {
  const SELECTORS = {
    TIME_RANGE_CELL: '[data-test-id="time-range-cell"]',
    TIME_OFF_ICON: '[data-test-id="time-off-icon"]',
  };

  test("returns true when the row scope contains the time-off icon", () => {
    document.body.innerHTML = `
      <div id="row">
        <span data-test-id="alert-icon"></span>
        <div data-test-id="time-range-cell"></div>
        <span data-test-id="time-off-icon"></span>
      </div>
    `;
    const icon = document.querySelector('[data-test-id="alert-icon"]');
    expect(isTimeOffRow(icon, SELECTORS, 8)).toBe(true);
  });

  test("returns false for a normal row without the time-off icon", () => {
    document.body.innerHTML = `
      <div id="row">
        <span data-test-id="alert-icon"></span>
        <div data-test-id="time-range-cell"></div>
      </div>
    `;
    const icon = document.querySelector('[data-test-id="alert-icon"]');
    expect(isTimeOffRow(icon, SELECTORS, 8)).toBe(false);
  });

  test("returns false when no row scope can be found at all", () => {
    document.body.innerHTML = '<span data-test-id="alert-icon"></span>';
    const icon = document.querySelector('[data-test-id="alert-icon"]');
    expect(isTimeOffRow(icon, SELECTORS, 8)).toBe(false);
  });

  test("returns false when TIME_OFF_ICON selector isn't configured", () => {
    document.body.innerHTML = `
      <div id="row">
        <span data-test-id="alert-icon"></span>
        <div data-test-id="time-range-cell"></div>
        <span data-test-id="time-off-icon"></span>
      </div>
    `;
    const icon = document.querySelector('[data-test-id="alert-icon"]');
    expect(isTimeOffRow(icon, { TIME_RANGE_CELL: SELECTORS.TIME_RANGE_CELL }, 8)).toBe(false);
  });
});

describe("simulateClick", () => {
  test("dispatches a full pointer/mouse event sequence in order", () => {
    document.body.innerHTML = "<button id=\"btn\"></button>";
    const btn = document.getElementById("btn");
    btn.getBoundingClientRect = () => ({ left: 10, top: 20, width: 4, height: 6 });

    const seen = [];
    ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => {
      btn.addEventListener(type, (e) => seen.push({ type: e.type, x: e.clientX, y: e.clientY }));
    });

    simulateClick(btn);

    expect(seen.map((e) => e.type)).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
    seen.forEach((e) => {
      expect(e.x).toBe(12); // 10 + 4/2
      expect(e.y).toBe(23); // 20 + 6/2
    });
  });
});

describe("getTimeSegments", () => {
  function segment(label) {
    const span = document.createElement("span");
    span.setAttribute("role", "spinbutton");
    span.setAttribute("aria-label", label);
    return span;
  }

  test("resolves hours/minutes by aria-label when el is the wrapper", () => {
    const wrapper = document.createElement("div");
    const minutes = segment("minutes");
    const hours = segment("hours");
    wrapper.appendChild(hours);
    wrapper.appendChild(minutes);

    const result = getTimeSegments(wrapper);
    expect(result.hours).toBe(hours);
    expect(result.minutes).toBe(minutes);
  });

  test("falls back to positional segments when aria-label is missing", () => {
    const wrapper = document.createElement("div");
    const first = document.createElement("span");
    first.setAttribute("role", "spinbutton");
    const second = document.createElement("span");
    second.setAttribute("role", "spinbutton");
    wrapper.appendChild(first);
    wrapper.appendChild(second);

    const result = getTimeSegments(wrapper);
    expect(result.hours).toBe(first);
    expect(result.minutes).toBe(second);
  });

  test("walks up to a role=group ancestor when el is itself a spinbutton segment", () => {
    const group = document.createElement("div");
    group.setAttribute("role", "group");
    const hours = segment("hours");
    const minutes = segment("minutes");
    group.appendChild(hours);
    group.appendChild(minutes);

    const result = getTimeSegments(hours);
    expect(result.hours).toBe(hours);
    expect(result.minutes).toBe(minutes);
  });

  test("returns an empty object when el is falsy", () => {
    expect(getTimeSegments(null)).toEqual({});
  });
});

describe("resolveRowElements", () => {
  function buildRow() {
    document.body.innerHTML = `
      <div id="scope">
        <div data-test-id="periods.0.start"></div>
        <div data-test-id="periods.0.end"></div>
        <div data-test-id="periods.1.start"></div>
        <div data-test-id="periods.1.end"></div>
      </div>
    `;
  }

  const selectors = [
    '[data-test-id="periods.0.start"]',
    '[data-test-id="periods.0.end"]',
    '[data-test-id="periods.1.start"]',
    '[data-test-id="periods.1.end"]',
  ];

  test("resolves the scope and all elements when every selector is present", async () => {
    buildRow();
    const anchor = document.querySelector('[data-test-id="periods.0.start"]');
    const result = await resolveRowElements(anchor, selectors, 8, 200, 10);

    expect(result).not.toBeNull();
    expect(result.scope).toBe(document.getElementById("scope"));
    expect(result.elements).toHaveLength(4);
  });

  test("resolves null when one of the required fields never appears", async () => {
    document.body.innerHTML = `
      <div id="scope">
        <div data-test-id="periods.0.start"></div>
        <div data-test-id="periods.0.end"></div>
        <div data-test-id="periods.1.start"></div>
      </div>
    `;
    const anchor = document.querySelector('[data-test-id="periods.0.start"]');
    const result = await resolveRowElements(anchor, selectors, 8, 60, 10);

    expect(result).toBeNull();
  });
});
