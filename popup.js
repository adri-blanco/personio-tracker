const STORAGE_KEY = "personioAutoFillerLastRun";

// The button is only ever disabled for this short window right after a click,
// purely to prevent accidental double-clicks. It is intentionally NEVER tied
// to the persisted "running" state: if a run stalls or the content script
// dies without reporting back, the button must stay usable so the user can
// simply try again instead of being locked out until storage is cleared.
const CLICK_DEBOUNCE_MS = 2000;

const CONFIG = self.PersonioConfig;

const appEl = document.getElementById("app");
const runButton = document.getElementById("run-button");
const runCurrentTabButton = document.getElementById("run-current-tab-button");
const statusDot = document.getElementById("status-dot");
const statusLine = document.getElementById("status-line");
const readoutFixed = document.getElementById("readout-fixed");
const readoutTotal = document.getElementById("readout-total");
const readoutCaption = document.getElementById("readout-caption");
const skippedList = document.getElementById("skipped-list");

// Maps a status onto the CSS-facing `data-state` used to drive the status
// dot color, the LED readout color, and the status line color. "done" is
// split into a real-save vs. dry-run flavor since they mean very different
// things (data persisted vs. nothing touched).
function cssState({ state, dryRun }) {
  if (state === "done") return dryRun ? "done-dry" : "done";
  return state || "idle";
}

function renderStatus(status) {
  skippedList.innerHTML = "";

  if (!status) {
    appEl.dataset.state = "idle";
    statusDot.setAttribute("aria-label", "Idle");
    statusLine.textContent = "Idle. Click Run to start.";
    readoutFixed.textContent = "--";
    readoutTotal.textContent = "--";
    readoutCaption.textContent = "rows fixed / total";
    return;
  }

  const { state, total = 0, fixed = 0, skipped = 0, skippedDetails = [], error, dryRun } = status;

  appEl.dataset.state = cssState(status);

  switch (state) {
    case "opening-tab":
      statusDot.setAttribute("aria-label", "Opening tab");
      statusLine.textContent = "Opening Personio tab...";
      readoutCaption.textContent = "starting up";
      break;
    case "waiting-for-icons":
      statusDot.setAttribute("aria-label", "Waiting");
      statusLine.textContent = "Waiting for alert icons to appear...";
      readoutCaption.textContent = "starting up";
      break;
    case "running":
      statusDot.setAttribute("aria-label", "Running");
      statusLine.textContent = `Running: ${fixed + skipped}/${total} processed (fixed ${fixed}, skipped ${skipped})`;
      readoutCaption.textContent = "live \u00b7 filling rows";
      break;
    case "done":
      statusDot.setAttribute("aria-label", dryRun ? "Dry run done" : "Done");
      statusLine.textContent = dryRun
        ? `Dry run done: filled ${fixed}/${total}, skipped ${skipped}. Nothing was saved.`
        : `Done: fixed ${fixed}/${total}, skipped ${skipped}.`;
      readoutCaption.textContent = dryRun ? "rows filled \u00b7 dry run" : "rows fixed \u00b7 saved";
      break;
    case "error":
      statusDot.setAttribute("aria-label", "Error");
      statusLine.textContent = `Error: ${error || "unknown error"} (click Run to retry)`;
      readoutCaption.textContent = "rows fixed \u00b7 stopped";
      break;
    default:
      statusDot.setAttribute("aria-label", "Idle");
      statusLine.textContent = "Idle. Click Run to start.";
      readoutCaption.textContent = "rows fixed / total";
  }

  readoutFixed.textContent = String(fixed).padStart(2, "0");
  readoutTotal.textContent = String(total).padStart(2, "0");

  skippedDetails.forEach((detail) => {
    const li = document.createElement("li");
    const rowLabel = document.createElement("span");
    rowLabel.className = "row-label";
    rowLabel.textContent = `Row ${detail.index + 1}:`;
    li.appendChild(rowLabel);
    li.appendChild(document.createTextNode(` ${detail.reason}`));
    skippedList.appendChild(li);
  });
}

async function loadLastStatus() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  renderStatus(data[STORAGE_KEY]);
}

// Only offer "Run on this tab" when the tab that's actually active *right
// now* is already a Personio attendance/employee page - otherwise clicking
// it would just fail in background.js, and showing it unconditionally would
// be misleading (e.g. while the popup is open over some unrelated page).
async function refreshCurrentTabButtonVisibility() {
  let matches = false;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    matches = !!(tab && tab.url && CONFIG.ATTENDANCE_URL_PATTERN.test(tab.url));
  } catch (err) {
    matches = false;
  }
  runCurrentTabButton.hidden = !matches;
}

function triggerRun(message, button) {
  button.disabled = true;
  setTimeout(() => {
    button.disabled = false;
  }, CLICK_DEBOUNCE_MS);

  appEl.dataset.state = "opening-tab";
  statusLine.textContent = "Starting...";
  readoutCaption.textContent = "starting up";
  skippedList.innerHTML = "";
  chrome.runtime.sendMessage(message);
}

runButton.addEventListener("click", () => {
  triggerRun({ type: "PERSONIO_AUTOFILLER_RUN" }, runButton);
});

runCurrentTabButton.addEventListener("click", () => {
  triggerRun({ type: "PERSONIO_AUTOFILLER_RUN_CURRENT_TAB" }, runCurrentTabButton);
});

chrome.runtime.onMessage.addListener(() => {
  // Background persists every update to storage before/around broadcasting it,
  // so re-reading storage keeps the popup and the stored log in sync.
  setTimeout(loadLastStatus, 50);
});

loadLastStatus();
refreshCurrentTabButtonVisibility();
