# 🚨 Air Alerts Telegram — Zhytomyr District, Ukraine

🇬🇧 **English** | 🇺🇦 [Українська](README.md)

[![Tests](https://img.shields.io/badge/tests-Node.js%20built--in-blue)](#testing)
[![Platform](https://img.shields.io/badge/platform-Google%20Apps%20Script-green)](https://developers.google.com/apps-script)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Air Alerts Telegram** is an independent, serverless notification project that monitors air raid alerts for **Zhytomyr District, Ukraine** and posts updates to a Telegram channel. It is built with Google Apps Script, uses the publicly accessible Ubilling / alerts.in.ua data feed, and stores an event history in Google Sheets.

> **Safety notice:** This is **not** an official emergency notification system. API failures, scheduling delays and Telegram outages can delay messages. Always follow official Ukrainian air raid alert services and civil protection instructions. Never use this project as your only source of safety information.

## Features

- Checks alerts **every minute**, combining the district (`59`) and region (`10`) when the entire Zhytomyr region is affected.
- Publishes state changes only: 🟡 **yellow**, 🔴 **red**, and 🟢 **all clear**. Drone-related warnings are represented by the yellow level in this implementation, **not counted as a separate alert type**.
- Includes the elapsed alert duration in all-clear messages.
- Records events in Google Sheets (`Тривоги`, `Події`, `Тижневі звіти`).
- Posts a weekly summary on Mondays at approximately **08:00 Europe/Kyiv**, with counts and durations.
- Removes operational alert messages after approximately **24 hours**; weekly reports are preserved.
- Uses **silent Telegram notifications from 22:00 through 06:59** local Kyiv time (including daylight-saving changes). Messages are still posted immediately, just without a notification sound.
- Prevents duplicate state updates within one installation; retries certain transient API errors.
- Keeps the Telegram token, target chat ID, channel footer and spreadsheet ID in **Apps Script Properties**, not source control.

## Repository layout

```text
air-alerts-github/
├── src/
│   ├── Code.gs                 # Google Apps Script implementation
│   └── appsscript.json         # Apps Script manifest
├── tests/
│   └── bot.test.cjs            # Offline unit tests
├── docs/
│   └── SCRIPT_PROPERTIES.md    # Configuration and migration (Ukrainian)
├── .github/workflows/ci.yml  # Test workflow (no deployment)
├── .clasp.json.example         # Example clasp binding
├── .gitignore
├── LICENSE
├── README.en.md
└── README.md
```

## Quick start (separate Apps Script installation)

**Do not modify your existing production Apps Script.** Create a separate Google Apps Script project and **test Telegram channel**. Running two projects against the same channel will cause duplicates.

1. Create a **new project** at [Google Apps Script](https://script.google.com/).
2. Copy `src/Code.gs` into the new project's `Code.gs`. Set the project timezone to `Europe/Kyiv`; you can also use `src/appsscript.json` for the manifest.
3. Create a **separate Google Sheet** for the alert history and copy its spreadsheet ID from the URL (the part between `/d/` and `/edit`). Keep it private.
4. In Apps Script, navigate to **Project Settings → Script Properties** and add the following values:

   | Property | Example / purpose |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | Bot token obtained from [@BotFather](https://t.me/BotFather) |
   | `TARGET_CHAT_ID` | `@your_test_channel` or the numeric destination chat ID |
   | `CHANNEL_FOOTER` | `📲 @your_test_channel` — text appended to messages |
   | `HISTORY_SPREADSHEET_ID` | ID of the new Google Sheet |

5. Add your bot as an **administrator of the test channel**, allowed to post and delete messages.
6. Run `testDistrictLevelsApi()` to check the API without posting, followed by `testHistoryConnection()` to check spreadsheet access; grant the requested permissions.
7. Run `testYellowMessage()` to post a clearly marked test message. It is scheduled for cleanup after approximately 2–5 minutes.
8. Run `setupAutomation()` to install monitoring, cleanup and weekly summary triggers. Run `showSystemStatus()` to inspect the status without printing secrets.

On the first run, `PUBLISH_CURRENT_ON_SCOPE_CHANGE: false` means the script **records the current state without posting it**. Subsequent changes are published. This is intentional for new installations.

## Optional deployment via clasp

You can manage a **separate** Apps Script project with [clasp](https://developers.google.com/apps-script/guides/clasp):

```bash
npm install -g @google/clasp
clasp login
cp .clasp.json.example .clasp.json
# Replace the placeholder in .clasp.json with your NEW project Script ID
clasp push
```

Enable the Google Apps Script API in your Apps Script user settings if requested. **Warning:** `clasp push` overwrites the destination Apps Script project files. Never point `.clasp.json` to the production project's Script ID. The real `.clasp.json` and credential files are excluded by `.gitignore`.

## Publish to GitHub

From the project directory:

```bash
git init
git add .
git commit -m "Initial public-safe air alert notifier"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/ukraine-air-alerts-telegram.git
git push -u origin main
```

Alternatively, if [GitHub CLI](https://cli.github.com/) is installed and authenticated:

```bash
gh repo create ukraine-air-alerts-telegram --public --source=. --remote=origin --push
```

**Never commit:** Telegram bot tokens, private chat IDs, spreadsheet IDs, `.clasp.json`, `.clasprc.json`, exported Script Properties or backups containing secrets. If a token has ever been exposed, **revoke/regenerate it using BotFather**. Removing it in a later commit does not erase previous Git history.

## Testing

With Node.js installed, run:

```bash
node --test tests/*.test.cjs
```

Offline tests cover silent-hour boundaries (including Kyiv DST changes), threat-level prioritization, district/region mapping, Telegram silent-flag handling and basic secret scanning. The tests **do not access live APIs, post to Telegram, or verify a production deployment**. GitHub Actions runs the same tests on pushes and pull requests, without automated deployment.

## Limitations and operational notes

- Apps Script clock triggers are **approximate**, not real-time guarantees.
- This notifier requires data source and Telegram availability; regional IDs and response formats may change. Unknown or malformed API responses should never be assumed to be all clear.
- Deduplication works **per installation**; running two copies on one channel may produce duplicates.
- Script Properties belong to an individual Apps Script project. They do not automatically transfer to a copy and can be viewed by its editors, so restrict project access.
- Use a test channel before migration. To switch installations, stop the old project's triggers (`removeAutomation()`), then configure and enable the new one. **No change to the existing project is needed to publish the source on GitHub.**
- To change the monitored location, adjust `DISTRICT_UID`, `DISTRICT_NAME`, `OBLAST_UID`, `OBLAST_NAME`, and the user-facing messages together. Validate the source's identifiers first.

Full configuration and migration notes (Ukrainian): [docs/SCRIPT_PROPERTIES.md](docs/SCRIPT_PROPERTIES.md).

## License

[MIT](LICENSE). An independent open-source project; **not affiliated with official emergency services**.