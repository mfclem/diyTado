# diyTado

Link **tado° X** thermostats to **Google Home** via Google Apps Script — no cloud subscription, no third-party bridge.

The project runs entirely inside a single Apps Script project deployed as a Web App. It implements a full Google Home Cloud-to-cloud integration (OAuth account linking + smart-home fulfillment) backed by the tado° X API, plus proactive state push to the HomeGraph API and an optional Gemini AI assistant for natural-language queries.

---

## Architecture

```
Google Home app
      │  SYNC / QUERY / EXECUTE  (HTTPS POST)
      ▼
Apps Script Web App  (GoogleHomeAction.js)
      │  tado° X REST API  (Bearer token, auto-refreshed)
      ▼
tado° X cloud  (my.tado.com/api/v2  +  hops.tado.com)

Apps Script time trigger  (every N minutes)
      │  HomeGraph API  (service-account JWT)
      ▼
Google HomeGraph  (Homegraph.js)
```

**Files**

| File | Purpose |
|---|---|
| `Tado.js` | tado° X API client — OAuth device-code flow, token refresh, all API wrappers, schedule helpers |
| `GoogleHomeAction.js` | Google Home fulfillment Web App — OAuth endpoints, SYNC / QUERY / EXECUTE / DISCONNECT |
| `Homegraph.js` | Proactive state push to Google HomeGraph via a service-account JWT |
| `GenAIApp.js` | Third-party library for Gemini / OpenAI function-calling (used by `Main.js`) |
| `Main.js` | Utility / test functions — `run()`, `readRooms()`, `getThermostatsStates()` |
| `appsscript.json` | Apps Script manifest — runtime, OAuth scopes, BetterLog library, Web App config |

---

## Google Home devices exposed

For every tado° X room the integration creates five devices:

| Device name | Type | Trait | What it does |
|---|---|---|---|
| `<Room>` | Thermostat | `TemperatureSetting` | Read/set temperature; modes: `off` / `heat` (manual hold) / `auto` (resume schedule) |
| `<Room> — Open Window` | Sensor | `OpenClose` | Reports whether open-window mode is active |
| `<Room> — Heating` | Sensor | `SensorState` | Reports ACTIVE / INACTIVE based on heating power |
| `<Room> — Humidity` | Sensor | `HumiditySetting` | Reports ambient humidity percentage |
| `Resume <Room>` | Switch | `OnOff` | Momentary — turning ON resumes the tado° schedule for that room |

Plus four whole-home devices:

| Device name | Type | What it does |
|---|---|---|
| `Presence` | Switch | on = HOME, off = AWAY. State always reflects real tado° presence. Toggling sets the presence lock accordingly |
| `Boost Heating` | Switch | Activates boost mode for all rooms |
| `Heating Off` | Switch | Turns off all rooms with a manual hold. Use `Activate Schedule` to restore heating |
| `Activate Schedule` | Switch | Immediately activates the tado° schedule for all rooms, clearing all manual overrides |

Per-room `Resume <Room>` switches hand back to the schedule at the **next block boundary** (keeping the current temperature until then). `Activate Schedule` acts **immediately** across all rooms.

**State reporting** — devices marked `willReportState: true` (thermostats, sensors, Set Home, Set Away) push live state to HomeGraph via `apiReportStateAndNotification()`. Momentary switches (boost, resume, per-room resume) are polled on demand.

---

## Prerequisites

### Script Properties

Set all of the following in the Apps Script project under **Project Settings → Script Properties**:

| Property | Description |
|---|---|
| `SERVICE_ACCOUNT_EMAIL` | E-mail of the GCP service account used for HomeGraph JWT auth |
| `SERVICE_ACCOUNT_PRIVATE_KEY` | RSA private key from the service account JSON key file. Paste the full `-----BEGIN PRIVATE KEY-----…` block with literal `\n` for newlines |
| `SPREADSHEET` | ID of the Google Spreadsheet used by BetterLog for execution logs |
| `GEMINI_API_KEY` | Gemini API key (only required if using `getThermostatsStates()` in `Main.js`) |

The following properties are written automatically by the setup functions below:

| Property | Written by |
|---|---|
| `TADO_TOKENS` | `authorizeTado()` |
| `GH_CLIENT_ID` | `setupGoogleHomeAction()` |
| `GH_CLIENT_SECRET` | `setupGoogleHomeAction()` |
| `GH_LINK_TOKEN` | `setupGoogleHomeAction()` |
| `GH_URL_KEY` | `setupGoogleHomeAction()` |
| `GH_AGENT_USER_ID` | `setupGoogleHomeAction()` |
| `GH_HOME_ID` | `setupGoogleHomeAction()` |

### GCP project

1. Enable the **HomeGraph API** in your GCP project.
2. Create a **Service Account**, download a JSON key, and copy the e-mail and private key into the Script Properties above.
3. Grant the service account the **Home Graph Service Agent** role (or at minimum `homegraph.devices.reportStateAndNotification`).

---

## One-time setup

Follow these steps in order.

### 1. Deploy the Web App

In the Apps Script editor: **Deploy → New deployment → Web app**
- Execute as: **Me**
- Who has access: **Anyone**

Copy the resulting `/exec` URL.

### 2. Authorize tado°

Run `authorizeTado()` once from the editor. It prints a URL — open it in a browser, log in to tado° and approve access. The function blocks until you approve, then stores the tokens in Script Properties.

### 3. Generate Google Home secrets

Run `setupGoogleHomeAction()` once from the editor. It generates and stores all OAuth secrets and prints:
- `Client ID` and `Client secret` — paste into the Google Home Developer Console
- `URL key (k)` — embedded in every registered URL
- The three URLs to register (fulfillment, authorization, token) — each already carries `?k=<key>`

### 4. Register the integration in the Google Home Developer Console

Create a **Cloud-to-cloud** integration:
- **Fulfillment URL**: `<exec URL>?k=<key>`
- **Account linking**: OAuth / Authorization Code
  - Client ID / secret: from step 3
  - **Authorization URL**: `<exec URL>?p=auth&k=<key>`
  - **Token URL**: `<exec URL>?p=token&k=<key>`

### 5. Link the account in Google Home

In the Google Home app, add the `[test]` integration and link the account. Your rooms and devices will appear.

### 6. Set up proactive state reporting (recommended)

Create a **time-based trigger** in Apps Script on `apiReportStateAndNotification()` — every 5 minutes is a good interval. This keeps Google Home in sync without waiting for a poll.

If rooms are added or removed in tado°, or after any deployment that changes the device list, run `apiRequestSync()` manually (or trigger it) to ask Google to re-run SYNC and re-discover all devices.

---

## Development

### clasp

The project uses [clasp](https://github.com/google/clasp) to sync code between this repo and Apps Script.

```bash
# Push local changes to Apps Script
clasp push

# Pull latest from Apps Script
clasp pull
```

The script ID is in `.clasp.json`; source files live in `code/`.

### GitHub Actions

| Workflow | Trigger | What it does |
|---|---|---|
| `deploy.yml` | Push to `main` / Manual | Runs `clasp push` to deploy to Apps Script |
| `pull.yml` | Manual | Runs `clasp pull` to sync from Apps Script |

### Test functions

Run these directly from the Apps Script editor to validate without Google Home:

| Function | What it does |
|---|---|
| `test_sync()` | Logs the full SYNC payload |
| `test_query()` | Logs QUERY state for every thermostat room |
| `test_executeSetpoint()` | Sets the first room to 21 °C via the EXECUTE path (live write) |
| `apiQuery()` | Queries HomeGraph for current device states |
| `apiReportStateAndNotification()` | Pushes current state to HomeGraph immediately |

---

## Resources

- [`resources/`](resources/) — SmartThings rules and Google Home automations for climate control scenes
- tado° X API auth docs: https://support.tado.com/en/articles/8565472
- tado° X Postman collection: https://github.com/gedhi/tadox-postman-collection
- tado° v2 OpenAPI spec: https://github.com/kritsel/tado-openapispec-v2
