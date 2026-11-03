# 🚨 Air Alerts Telegram — Air Raid Alert Notifications for Ukraine

🇬🇧 **English** | 🇺🇦 [Українська](README.md)

[![Tests](https://img.shields.io/badge/tests-Node.js%20built--in-blue)](#testing)
[![Platform](https://img.shields.io/badge/platform-Google%20Apps%20Script-green)](https://developers.google.com/apps-script)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Air Alerts Telegram** is an open-source, serverless template for Telegram air raid alert notifications in Ukraine. Its **default example monitors Zhytomyr District**, including region-wide alerts. Built with Google Apps Script, it uses the Ubilling / alerts.in.ua feed and Google Sheets for event history. The template can be adapted to other Ukrainian districts and regions supported by the data source.

> **Safety notice:** This is **not** an official emergency notification system. API failures, scheduling delays and Telegram outages can delay messages. Always follow official Ukrainian air raid alert services and civil protection instructions. Never use this project as your only source of safety information.

## 🌍 Configure Other Ukrainian Regions Without Editing Code

**Zhytomyr District is only the example configuration.** The new version selects a monitoring territory with **Google Apps Script → Script Properties**. You do not need to edit `src/Code.gs`.

- **`REGION_MODE=district`** monitors the selected district **plus** region-wide alerts.
- **`REGION_MODE=oblast`** monitors alerts issued **at the oblast (region) level**. To include district-specific alerts, explicitly list verified district IDs in `ADDITIONAL_DISTRICT_UIDS`. Without them, **district alerts across the entire oblast are not covered**.

| Property | District mode | Oblast mode |
|---|---|---|
| `REGION_MODE` | `district` | `oblast` |
| `DISTRICT_UID`, `DISTRICT_NAME` | Required | Leave unset |
| `OBLAST_UID`, `OBLAST_NAME` | Required | Required |
| `ADDITIONAL_DISTRICT_UIDS` | Leave unset | Optional comma-separated district IDs |

When **no regional properties** are set, the bundled example uses **Zhytomyr District (59) and Zhytomyr Oblast (10)**. For other territories, supply a complete configuration; partially filled settings do not silently inherit the sample IDs.

Run **`setupRegion()`** before enabling triggers. It checks configuration and active API events, but **cannot confirm the existence of a UID when no relevant alert is active**. Verify identifiers against current source data. Use a separate Google Sheet for each monitoring territory.

See the detailed [configuration and safety guide](docs/SCRIPT_PROPERTIES.md) (Ukrainian).

## Features

- Checks alerts **every minute** for the territory selected via Script Properties (default example: district `59` and region `10`).
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
6. For another region, set the additional Script Properties shown above. Run `setupRegion()` to inspect the configuration and API **without posting**; verify UID values against the data source even when no alerts are active. Then run `testHistoryConnection()` and grant the necessary permissions.
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
- Select your location using Script Properties, without editing source code. Oblast mode does **not** automatically aggregate district-level alerts unless their verified IDs are listed in `ADDITIONAL_DISTRICT_UIDS`. An empty active-alert result does not validate a location UID.

Full configuration and migration notes (Ukrainian): [docs/SCRIPT_PROPERTIES.md](docs/SCRIPT_PROPERTIES.md).

## License

[MIT](LICENSE). An independent open-source project; **not affiliated with official emergency services**.