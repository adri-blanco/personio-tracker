import "./config.js";

const CONFIG = self.PersonioConfig;
const STORAGE_KEY = "personioAutoFillerLastRun";

function setBadge(text, color) {
  chrome.action.setBadgeText({ text: text || "" });
  if (color) {
    chrome.action.setBadgeBackgroundColor({ color });
  }
}

async function getStatus() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || null;
}

async function saveStatus(status) {
  await chrome.storage.local.set({ [STORAGE_KEY]: status });
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sendStartWithRetry(tabId, attempts, delayMs) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "PERSONIO_AUTOFILLER_START" });
      return true;
    } catch (err) {
      if (attempt === attempts - 1) return false;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

function armWatchdog(runId) {
  setTimeout(async () => {
    const current = await getStatus();
    if (!current || current.runId !== runId) return; // A newer run has taken over.
    if (current.state === "done" || current.state === "error") return;

    await saveStatus({
      ...current,
      state: "error",
      error: "Timed out: no update from the page for " + Math.round(CONFIG.TIMEOUTS.MAX_RUN_MS / 1000) + "s. The tab may have navigated away or the content script crashed.",
      finishedAt: Date.now(),
    });
    setBadge("!", "#d9534f");
  }, CONFIG.TIMEOUTS.MAX_RUN_MS);
}

// Shared by startRun() and startRunOnCurrentTab(): initializes status/badge/
// watchdog, resolves the target tab via `resolveTab` (which throws a
// user-facing message on failure), then kicks off the content script on it.
async function beginRun(resolveTab) {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const status = {
    runId,
    state: "opening-tab",
    total: 0,
    fixed: 0,
    skipped: 0,
    skippedDetails: [],
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  await saveStatus(status);
  setBadge("...", "#f0ad4e");
  armWatchdog(runId);

  let tab;
  try {
    tab = await resolveTab();
  } catch (err) {
    status.state = "error";
    status.error = String((err && err.message) || err);
    status.finishedAt = Date.now();
    await saveStatus(status);
    setBadge("!", "#d9534f");
    return;
  }

  status.state = "running";
  await saveStatus(status);

  const started = await sendStartWithRetry(tab.id, 5, 400);
  if (!started) {
    status.state = "error";
    status.error = "Could not reach the content script on the target tab.";
    status.finishedAt = Date.now();
    await saveStatus(status);
    setBadge("!", "#d9534f");
  }
}

// Default entry point: always opens a fresh tab pinned to CONFIG.TARGET_URL,
// which shows the current month for the configured employee id.
async function startRun() {
  await beginRun(async () => {
    let tab;
    try {
      tab = await chrome.tabs.create({ url: CONFIG.TARGET_URL });
    } catch (err) {
      throw new Error("Could not open the target tab: " + String((err && err.message) || err));
    }
    await waitForTabComplete(tab.id);
    return tab;
  });
}

// Runs on whatever Personio attendance/employee page is already open and
// active in the current tab, preserving its current view (e.g. a past month
// the user navigated to manually) instead of forcing back to TARGET_URL's
// current month.
async function startRunOnCurrentTab() {
  await beginRun(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      throw new Error("Could not find the active tab.");
    }
    if (!tab.url || !CONFIG.ATTENDANCE_URL_PATTERN.test(tab.url)) {
      throw new Error("The active tab is not a Personio attendance/employee page.");
    }
    return tab;
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || !message.type) return;

  if (message.type === "PERSONIO_AUTOFILLER_RUN") {
    startRun();
    return;
  }

  if (message.type === "PERSONIO_AUTOFILLER_RUN_CURRENT_TAB") {
    startRunOnCurrentTab();
    return;
  }

  if (!sender.tab) return; // Everything below only comes from the content script.

  handleContentMessage(message);
});

async function handleContentMessage(message) {
  const prev = (await getStatus()) || {
    total: 0,
    fixed: 0,
    skipped: 0,
    skippedDetails: [],
  };

  switch (message.type) {
    case "PERSONIO_AUTOFILLER_STATUS": {
      await saveStatus({
        ...prev,
        state: message.state,
        total: message.total ?? prev.total,
      });
      break;
    }
    case "PERSONIO_AUTOFILLER_PROGRESS": {
      const fixed = prev.fixed + (message.result === "fixed" ? 1 : 0);
      const skipped = prev.skipped + (message.result === "skipped" ? 1 : 0);
      const skippedDetails =
        message.result === "skipped"
          ? [...prev.skippedDetails, { index: message.index, reason: message.reason }]
          : prev.skippedDetails;

      const next = {
        ...prev,
        state: "running",
        total: message.total,
        fixed,
        skipped,
        skippedDetails,
      };
      await saveStatus(next);
      setBadge(`${fixed}/${next.total}`, "#f0ad4e");
      break;
    }
    case "PERSONIO_AUTOFILLER_DONE": {
      const next = {
        ...prev,
        state: "done",
        total: message.total,
        fixed: message.fixed,
        skipped: message.skipped,
        skippedDetails: message.skippedDetails || [],
        dryRun: !!message.dryRun,
        finishedAt: Date.now(),
      };
      await saveStatus(next);
      setBadge(`${next.fixed}/${next.total}`, next.skipped ? "#f0ad4e" : "#5cb85c");
      break;
    }
    case "PERSONIO_AUTOFILLER_ERROR": {
      await saveStatus({
        ...prev,
        state: "error",
        error: message.message,
        finishedAt: Date.now(),
      });
      setBadge("!", "#d9534f");
      break;
    }
    default:
      break;
  }
}
