# ⏱️ Personio Auto-Filler

Stop babysitting your timesheet. This Chrome extension scans your Personio attendance page for the rows flagged with a ⚠️ alert icon (missing time entries), fills them in with sensible default hours, and saves them — automatically.

## ✨ What it does

- Detects rows on your Personio attendance page that are missing time periods.
- Skips time-off rows (vacation, sick leave, etc.) — only touches genuinely missing entries.
- Fills each row with configurable start/end times, plus a small random jitter so every entry doesn't look identical.
- Saves row by row, and can resume automatically if Personio reloads the page mid-run.
- Optional **dry-run mode** to preview what would be filled without saving anything.
- Live popup showing progress (`fixed / total`), skipped rows with reasons, and a badge on the toolbar icon.

## 📦 Installation

1. Clone or download this repo.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the project folder.
5. Pin the extension for quick access from the toolbar.

## ⚙️ Configuration

All settings live in [`config.js`](./config.js) — edit and reload the extension to apply changes.

| Setting | What it controls |
| --- | --- |
| `TARGET_URL` | The Personio attendance URL opened when you click **Run**. Update the employee ID / subdomain to match your account. |
| `DRY_RUN` | `true` fills fields but never clicks Save — great for testing. Set to `false` once you trust the results. |
| `SELECTORS.PERIODS` | The default start/end times typed into each period (e.g. `900` = 09:00). Add/remove entries to match your work schedule (e.g. split shifts). |
| `JITTER_MAX_MINUTES` | Randomizes each typed time by up to this many minutes, so entries don't look robotic. |
| `TIMEOUTS` | Tune how long the extension waits for page elements and how fast it clicks through rows/saves. |

> ⚠️ If your Personio subdomain differs from `personio.com`/`personio.de`, also update `host_permissions` and `content_scripts.matches` in [`manifest.json`](./manifest.json).

## 🚀 Usage

1. Click the extension icon.
2. Hit **Run** to open your timesheet and auto-fill missing rows, or **Run on this tab** if you're already on a Personio attendance page (handy for backfilling past months).
3. Watch the live readout — it'll tell you exactly what got fixed and what was skipped.

## 🧪 Tests

```bash
npm install
npm test
```

Unit tests cover the core time/DOM/row-processing logic in `lib/`.
