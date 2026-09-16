// Content script. Loaded (after config.js and lib/*.js, see manifest.json)
// on every Personio page matching the configured host patterns. Stays idle
// until it receives a PERSONIO_AUTOFILLER_START message from background.js.
(function () {
  const CONFIG = self.PersonioConfig;
  const SEL = CONFIG.SELECTORS;
  const TIMEOUTS = CONFIG.TIMEOUTS;
  const { waitForElement } = self.PersonioDomUtils;
  const { processRow } = self.PersonioRowProcessor;

  function send(message) {
    try {
      chrome.runtime.sendMessage(message);
    } catch (err) {
      // Extension context can be invalidated if the page navigates away mid-run.
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function runAutomation() {
    send({ type: "PERSONIO_AUTOFILLER_STATUS", state: "waiting-for-icons" });

    const firstIcon = await waitForElement(SEL.ALERT_ICON, TIMEOUTS.WAIT_FOR_FIRST_ALERT_ICON_MS, TIMEOUTS.POLL_INTERVAL_MS);
    if (!firstIcon) {
      send({ type: "PERSONIO_AUTOFILLER_ERROR", message: "No alert-icon elements appeared in time." });
      return;
    }

    // Snapshot once: icons stay visible even after a row is fixed, so we must
    // NOT re-query for "remaining" icons or the loop would never terminate.
    const icons = Array.from(document.querySelectorAll(SEL.ALERT_ICON));
    const total = icons.length;
    send({ type: "PERSONIO_AUTOFILLER_STATUS", state: "running", total });

    const seenInputs = new Set();
    let fixed = 0;
    let skipped = 0;
    const skippedDetails = [];

    for (let index = 0; index < icons.length; index += 1) {
      const icon = icons[index];
      try {
        await processRow({
          icon,
          seenInputs,
          selectors: SEL,
          timeouts: TIMEOUTS,
          maxRowAncestorLevels: CONFIG.MAX_ROW_ANCESTOR_LEVELS,
          jitterMaxMinutes: CONFIG.JITTER_MAX_MINUTES,
          dryRun: CONFIG.DRY_RUN,
        });

        fixed += 1;
        send({
          type: "PERSONIO_AUTOFILLER_PROGRESS",
          index,
          total,
          result: "fixed",
          dryRun: CONFIG.DRY_RUN,
        });
      } catch (err) {
        skipped += 1;
        const reason = String((err && err.message) || err);
        skippedDetails.push({ index, reason });
        send({ type: "PERSONIO_AUTOFILLER_PROGRESS", index, total, result: "skipped", reason });
      }

      await sleep(TIMEOUTS.BETWEEN_ROWS_DELAY_MS);
    }

    send({ type: "PERSONIO_AUTOFILLER_DONE", total, fixed, skipped, skippedDetails, dryRun: CONFIG.DRY_RUN });
  }

  let running = false;

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "PERSONIO_AUTOFILLER_START") {
      if (running) return;
      running = true;
      // Guarantee a terminal message is always sent, even if something
      // outside the per-row try/catch throws (e.g. page navigates away),
      // so the popup/background never get stuck showing "running" forever.
      runAutomation()
        .catch((err) => {
          send({ type: "PERSONIO_AUTOFILLER_ERROR", message: String((err && err.message) || err) });
        })
        .finally(() => {
          running = false;
        });
    }
  });
})();
