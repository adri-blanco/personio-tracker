// Content script. Loaded (after config.js and lib/*.js, see manifest.json)
// on every Personio page matching the configured host patterns. Normally
// stays idle until it receives a PERSONIO_AUTOFILLER_START message from
// background.js - except it also self-resumes an interrupted run on load,
// see maybeResume() below.
(function () {
  const CONFIG = self.PersonioConfig;
  const SEL = CONFIG.SELECTORS;
  const TIMEOUTS = CONFIG.TIMEOUTS;
  const STORAGE_KEY = CONFIG.STORAGE_KEY;
  const { waitForElement, isTimeOffRow } = self.PersonioDomUtils;
  const { processRow } = self.PersonioRowProcessor;

  // Re-resolves the alert-icon list live from the DOM, applying the same
  // time-off filter as the initial snapshot. Used to fetch a fresh, still-
  // connected reference for a given row index instead of trusting a
  // reference captured earlier: a real Save can make Personio re-render the
  // whole table with brand-new DOM nodes for every row - even though the
  // count/order of alert-icons itself stays stable across that (see the
  // snapshot comment below) - silently detaching whatever reference was
  // captured upfront. Falls back to the original snapshot reference if a
  // fresh requery ever comes up short, rather than skipping the row
  // outright.
  function currentIconAt(index, fallbackIcons) {
    const currentIcons = Array.from(document.querySelectorAll(SEL.ALERT_ICON)).filter(
      (candidate) => !isTimeOffRow(candidate, SEL, CONFIG.MAX_ROW_ANCESTOR_LEVELS)
    );
    return currentIcons[index] || fallbackIcons[index];
  }

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

  // `resumeState` is set when this instance is picking up a run that a
  // previous (now-dead) instance of this content script didn't finish - see
  // maybeResume(). It carries over the fixed/skipped counts, details and
  // total from before, so progress reporting stays continuous across the
  // reload instead of looking like a brand-new, smaller run.
  async function runAutomation(resumeState) {
    const isResuming = !!resumeState;

    send({ type: "PERSONIO_AUTOFILLER_STATUS", state: "waiting-for-icons" });

    const firstIcon = await waitForElement(SEL.ALERT_ICON, TIMEOUTS.WAIT_FOR_FIRST_ALERT_ICON_MS, TIMEOUTS.POLL_INTERVAL_MS);
    if (!firstIcon) {
      // On a fresh run this means the page never showed a timesheet - a
      // real error. On a resume it just as plausibly means the last
      // remaining row(s) already got fixed before this instance loaded, so
      // there's nothing left rather than something broken.
      if (isResuming) {
        send({
          type: "PERSONIO_AUTOFILLER_DONE",
          total: resumeState.total,
          fixed: resumeState.fixed,
          skipped: resumeState.skipped,
          skippedDetails: resumeState.skippedDetails,
          dryRun: resumeState.dryRun,
        });
      } else {
        send({ type: "PERSONIO_AUTOFILLER_ERROR", message: "No alert-icon elements appeared in time." });
      }
      return;
    }

    // Snapshot once: icons stay visible even after a row is fixed, so we must
    // NOT re-query for "remaining" icons mid-loop or the loop would never
    // terminate. On a resume, this snapshot naturally already excludes rows
    // the previous instance actually saved before it died: Personio stops
    // showing the alert-icon on a row once it's genuinely saved.
    const allIcons = Array.from(document.querySelectorAll(SEL.ALERT_ICON));
    // Time-off rows (vacation, sick leave, etc.) also carry an alert-icon,
    // but are never auto-filled - exclude them upfront so the badge/popup
    // total only reflects rows that will actually be processed.
    const icons = allIcons.filter((icon) => !isTimeOffRow(icon, SEL, CONFIG.MAX_ROW_ANCESTOR_LEVELS));

    const dryRun = isResuming ? resumeState.dryRun : CONFIG.DRY_RUN;
    let fixed = isResuming ? resumeState.fixed : 0;
    let skipped = isResuming ? resumeState.skipped : 0;
    const skippedDetails = isResuming ? [...resumeState.skippedDetails] : [];
    // Keep the denominator stable (and only ever growing) across reloads,
    // rather than resetting it to whatever's left on the page right now, so
    // the popup's "x/total" reflects the whole logical run.
    const total = isResuming ? Math.max(resumeState.total, fixed + skipped + icons.length) : icons.length;

    send({ type: "PERSONIO_AUTOFILLER_STATUS", state: "running", total, dryRun });

    const seenInputs = new Set();
    // Stable row-number base for progress messages (equal to how many rows a
    // resumed run already accounted for, or 0 on a fresh run) - computed
    // once, since `fixed`/`skipped` themselves get mutated as the loop runs
    // and would no longer line up with a given row's position in `icons`.
    const initialOffset = fixed + skipped;

    for (let i = 0; i < icons.length; i += 1) {
      const icon = currentIconAt(i, icons);
      const index = initialOffset + i;
      try {
        await processRow({
          icon,
          seenInputs,
          selectors: SEL,
          timeouts: TIMEOUTS,
          maxRowAncestorLevels: CONFIG.MAX_ROW_ANCESTOR_LEVELS,
          jitterMaxMinutes: CONFIG.JITTER_MAX_MINUTES,
          dryRun,
        });

        fixed += 1;
        send({ type: "PERSONIO_AUTOFILLER_PROGRESS", index, total, result: "fixed", dryRun });
      } catch (err) {
        skipped += 1;
        const reason = String((err && err.message) || err);
        skippedDetails.push({ index, reason });
        send({ type: "PERSONIO_AUTOFILLER_PROGRESS", index, total, result: "skipped", reason, dryRun });
      }

      await sleep(TIMEOUTS.BETWEEN_ROWS_DELAY_MS);
    }

    send({ type: "PERSONIO_AUTOFILLER_DONE", total, fixed, skipped, skippedDetails, dryRun });
  }

  let running = false;

  function start(resumeState) {
    if (running) return;
    running = true;
    // Guarantee a terminal message is always sent, even if something
    // outside the per-row try/catch throws (e.g. the page navigates away),
    // so the popup/background never get stuck showing "running" forever.
    runAutomation(resumeState)
      .catch((err) => {
        send({ type: "PERSONIO_AUTOFILLER_ERROR", message: String((err && err.message) || err) });
      })
      .finally(() => {
        running = false;
      });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "PERSONIO_AUTOFILLER_START") {
      start();
    }
  });

  // A real (non-dry-run) Save can make Personio reload/re-render the whole
  // page - confirmed live: the in-flight content script instance simply
  // dies mid-loop with no error, so only the first row ever got filled and
  // the run silently stopped there. Since a fresh page load never gets a
  // second PERSONIO_AUTOFILLER_START message on its own, check on load
  // whether background.js's last known status for a run is still "running"
  // (i.e. the previous instance never got to send DONE/ERROR) and, if so,
  // pick up right where it left off instead of sitting idle forever.
  async function maybeResume() {
    // Content scripts run on every *.personio.{com,de} page, but a run only
    // ever makes sense on the attendance page itself - guards against
    // resuming (and prematurely reporting "done") if some other Personio
    // page happens to load in a tab while a run's status is still "running"
    // elsewhere.
    if (!CONFIG.ATTENDANCE_URL_PATTERN.test(location.href)) return;

    let data;
    try {
      data = await chrome.storage.local.get(STORAGE_KEY);
    } catch (err) {
      return; // Extension context not ready/available - just wait for START normally.
    }
    const status = data && data[STORAGE_KEY];
    if (!status || status.state !== "running") return;
    // total only becomes >0 once a previous instance actually counted the
    // icons (see the STATUS send above), so this also skips the harmless
    // race where background.js marks state "running" the instant it opens
    // the tab, before this same instance's own normal START handling.
    if (!(status.total > 0) || status.fixed + status.skipped >= status.total) return;
    // Only auto-continue if this "running" status was updated very
    // recently - a genuine Save-triggered reload picks back up within a
    // few seconds. Anything older is a stuck/abandoned run (background.js's
    // service worker can get killed before its own watchdog ever fires -
    // see RESUME_STALE_AFTER_MS in config.js) and must NOT silently start a
    // run just because this page happened to load; running is only ever
    // supposed to happen on purpose, via the popup's button.
    const lastActivity = status.updatedAt || status.startedAt || 0;
    if (Date.now() - lastActivity > TIMEOUTS.RESUME_STALE_AFTER_MS) return;

    start({
      fixed: status.fixed,
      skipped: status.skipped,
      skippedDetails: status.skippedDetails || [],
      total: status.total,
      dryRun: !!status.dryRun,
    });
  }

  maybeResume();
})();
