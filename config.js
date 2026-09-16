// Shared configuration for background.js, content/automation.js and popup.js.
// Edit TARGET_URL (and host_permissions / content_scripts matches in manifest.json
// if your Personio subdomain differs) before loading the extension.
(function () {
  const CONFIG = {
    TARGET_URL: "https://deus.app.personio.com/attendance/employee/20439319",

    // While true: fills in the period fields but never clicks Save, so
    // nothing is persisted. Flip to false once you've verified the fills
    // look correct.
    DRY_RUN: true,

    SELECTORS: {
      ALERT_ICON: '[data-test-id="alert-icon"]',
      // The alert-icon itself isn't clickable/interactive. Clicking the
      // empty time-range cell next to it (identified by this stable class
      // substring, since the CSS-module hash suffix can change between
      // builds) is what actually opens the period-editing panel.
      TIME_RANGE_CELL: '[class*="timeRangeColumn"]',
      // Rows for time-off (vacation, sick leave, etc.) also show an
      // alert-icon but must NOT be auto-filled like a regular missing-time
      // row, so we skip any row whose scope contains this icon. Confirmed
      // against the live page: it's `data-test-id`, same convention as the
      // other selectors above (previously assumed `data-testid`, which
      // silently matched zero elements and let time-off rows through).
      TIME_OFF_ICON: '[data-test-id="time-off-icon"]',
      SAVE_BUTTON: '[data-test-id="timecard-save-button"]',
      CANCEL_BUTTON: '[data-test-id="timecard-cancel-button"]',
      PERIODS: [
        { key: "periods.0.start", selector: '[data-test-id="periods.0.start"]', value: "900" },
        { key: "periods.0.end", selector: '[data-test-id="periods.0.end"]', value: "1800" },
        { key: "periods.1.start", selector: '[data-test-id="periods.1.start"]', value: "1400" },
        { key: "periods.1.end", selector: '[data-test-id="periods.1.end"]', value: "1500" },
      ],
    },

    TIMEOUTS: {
      WAIT_FOR_FIRST_ALERT_ICON_MS: 15000,
      WAIT_FOR_ROW_INPUTS_MS: 5000,
      POLL_INTERVAL_MS: 150,
      BETWEEN_ROWS_DELAY_MS: 250,
      TYPE_CHAR_DELAY_MS: 15,
      // Safety net: if a run is still "in progress" this long after starting
      // (e.g. the content script died silently, or the page navigated away),
      // background.js marks it as timed-out so the popup's Run button never
      // stays locked forever.
      MAX_RUN_MS: 5 * 60 * 1000,
    },

    // Each period value gets a fresh random offset added, in the range
    // [0, JITTER_MAX_MINUTES] minutes, independently per field. E.g. with
    // 900 and a max of 30, the actual typed time is a random point between
    // 09:00 and 09:30.
    JITTER_MAX_MINUTES: 30,

    // How many ancestor levels to walk up from a newly found "periods.0.start"
    // input while looking for the smallest container that also holds the other
    // 3 period inputs for that same row.
    MAX_ROW_ANCESTOR_LEVELS: 8,
  };

  self.PersonioConfig = CONFIG;
})();
