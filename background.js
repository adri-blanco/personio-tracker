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

async function startRun() {
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
    tab = await chrome.tabs.create({ url: CONFIG.TARGET_URL });
    await waitForTabComplete(tab.id);
  } catch (err) {
    status.state = "error";
    status.error = "Could not open the target tab: " + String((err && err.message) || err);
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
    status.error = "Could not reach the content script on the opened tab.";
    status.finishedAt = Date.now();
    await saveStatus(status);
    setBadge("!", "#d9534f");
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || !message.type) return;

  if (message.type === "PERSONIO_AUTOFILLER_RUN") {
    startRun();
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
