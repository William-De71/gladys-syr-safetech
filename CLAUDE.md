# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for the **SYR leak protection
devices** with a local JSON API (SafeTech Connect V3/V4/current, SafeTech+,
Trio DFR/LS, Trio LS, SafeTech Lock, TRIO Lock, Hansgrohe Pontos Base, RWC
MultiSafe and the same devices of other brands): a Node.js service (Node 22+,
ESM, no build step) in its own sandboxed Docker container, talking to Gladys
through [`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency, and to each device over HTTP on port 5333 of the
local network. `type: "device"`, Gladys 5.3.0+, `transports: ["local"]`, no
`network_discovery` (the devices do not announce themselves: the addresses are
typed). Not affiliated with SYR (Hans Sasserath).

**Never tested with a real device**: the paths, fields, formats and alarm codes
come from the community documentation of alexhass/syr_connect (Apache-2.0:
`docs/syrconnect-protocol.md`, `docs/known_issues_json_api.md`, its captures)
and ahornung/syr-safetech-connect-api (MIT), read for the facts only. None of
their code is used. The cloud (XML) API of SYR is not used.

## Commands

```bash
npm install
npm test                                  # node --test; fake SYR devices on a fake clock
node --test test/app.test.js              # one file
UPDATE_BASELINE=1 npm test                # rewrite test/fixtures/discovery.baseline.json (on purpose only)
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npx github:GladysAssistant/integration-store . --skip-image-check   # store checks
scripts/build-cover.sh                    # cover.jpg from docs/assets/cover.svg
docs/illustrations/render.sh              # docs/assets/widgets.<lang>.png
node .github/scripts/release.mjs next     # the version the next release would get
```

## Architecture

```
index.js                 SDK wiring only (new GladysIntegration + createApp)
src/app.js               every handler; the timer, the path of each address (/trio, /safe-tec,
                         /pontos-base, remembered), the device and its states, the commands
                         (switch, select, widget buttons, scene actions), scene events, widgets,
                         configuration buttons, status
src/syr-api.js           HTTP client (node:http, no keep-alive, 10 s timeout, port 5333 by default):
                         one queue per device, GET only, the body parsed as JSON whatever its headers
src/syr.js               the local API: the expert mode, /get/all into one shape (units, comma
                         decimals, getAB formats, getVLV motor states, alarm and warning tables,
                         profiles, battery level), the commands and their answers
src/consumption.js       water per day from the meter (first total of each day, 35 days kept)
src/device.js            the device, its features and states, alarm / warning texts
src/events.js            triggers (leak, alarm, cleared, warning, unreachable, back online), scene action keys
src/widgets.js           overview (with buttons), water per day
src/time.js              the timezone of Gladys (Intl only)
src/store.js             /data/syr.json (mode 0600)
src/config.js            addresses, interval, language
src/i18n.js              helpers; src/i18n-texts.js the runtime texts, en / fr / de / es
test/helpers/fake-syr.js        the fake network (/trio, /safe-tec, /pontos-base answers and commands)
test/fixtures/discovery.baseline.json   the frozen devices and manifest keys
.github/scripts/release.mjs     version, changelog, bump (tested in test/)
```

## Rules

- **External ids are forever**, and so is every key users store: the device
  `ext:<selector>:syr:<id>` (`<id>`: the serial number `getSRN` in lower case,
  letters and digits only); features `…:<key>` with the keys of `FEATURES` in
  `src/device.js` (`valve`, `leak`, `alarm`, `profile`, `flow`, `pressure`,
  `temperature`, `total_volume`, `today_volume`, `last_volume`,
  `current_volume`, `battery`, `battery_low`); feature `category` / `type` /
  `unit` / `min` / `max`, the keys of `config_schema` and `actions`,
  `last_language`, widgets and settings, the widget action keys
  (`close_valve`, `open_valve`, `reset_alarm`, `microleak_test`), triggers
  (fields, variables), the scene actions (fields, outputs), the profile option
  values (the profile numbers as strings). `test/structure.test.js` compares
  them to `test/fixtures/discovery.baseline.json`: never update it to make a
  test pass without a documented migration.
- **Category pairs**: switch / binary (`valve`, writable, `has_feedback`,
  1 = water flows); leak-sensor / binary; text / text (alarm); text / select
  (profile, writable, `supported_options` from the active profiles);
  water-valve / flow (m³/h); pressure-sensor / decimal (bar);
  temperature-sensor / decimal (°C); volume-sensor / decimal (m³ for the
  meter, L for the others); battery / integer (%); battery-low / binary.
- **Features appear once seen** (`device.present`), then stay.
- **The pace.** A timer reads every typed address every 10, 30 (default) or
  60 s. An address is recognised once (`/trio`, then `/safe-tec`, then
  `/pontos-base`) and remembered in the store; an address that is no SYR
  device is left alone 30 minutes (or until **Search and test** / a scan).
  A command reads the device again at once.
- **One request at a time per device**, never in parallel.
- **The expert mode** (`/set/ADM/(2)f`) only on `/safe-tec` and
  `/pontos-base`, before `/get/all`, every 30 minutes; a 404 means not needed.
- **`should_poll` stays false**: the integration has its own timer.
- **Commands**: the valve in the format of `getAB` (`true`/`false` on the
  newer, `2`/`1` on the older: 2 = closed); the profile `/set/prf/<n>`, only
  an active profile; the microleak test `/set/dex/true` (`1` when getTYP <
  100); the alarm `/set/ala/255` (common family) or `/clr/ala` (SafeTech
  family). Paths in lower case, values sent as they are (no
  percent-encoding). A reset from Gladys marks the device for 3 intervals so
  its own "alarm cleared" never fires.
- **Scene events** once per transition, never at the first reading of a
  device, never from a command: worked out after each reading round.
  Unreachable after 3 failed readings and at least a minute.
- **Names**: the device is offered as "SYR <model> <serial>" (or the brand
  of the model); the widgets and scenes use the name the user gave in Gladys
  (`getDevices`, refreshed on create / update / delete).
- **The container rootfs is read-only.** Write only under `/data`.
- **Four languages.** Every user-facing text (manifest, `src/i18n-texts.js`,
  `docs/*.md`, README) exists in en, fr, de, es; `test/i18n.test.js` checks it.
  German says "du", Spanish "usted".
- **Widget images.** After any change to a widget content, run
  `docs/illustrations/render.sh` again and look at the four PNG files.
- **Versions belong to the Release workflow**: never edit `version` in
  `package.json`, the lockfile or the manifest, nor the `docker_image` tag.
  Below 1.0.0 until the maintainer runs Release with `release-as: 1.0.0`.
- **Changelog.** Ne jamais éditer CHANGELOG.md à la main, il est généré à la
  release. Écris le titre de PR comme la ligne que l'utilisateur lira.
- **Commits and PR titles** follow Conventional Commits, in English.
- **Forum drafts** (`.github/forum-*.md`) are never committed.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.

## Pitfalls

- The devices send no `Content-Type`: parse the body as JSON whatever it says.
- Three formats of the same values: native JSON on `/trio` (`getAB` false,
  `getBAR` 4101 mbar, `getBAT` 619 = 6.19 V), strings with units on the older
  paths (`"4900 mbar"`, `"Vol[L]1885"`, `"9,36"`, `"0mL"`, `"1"`/`"2"`).
- Without the expert mode, the older firmwares answer `"ERROR: ADM"` for most
  values: `numberOf()` reads it as null.
- `getAB` is where the valve goes, `getVLV` where the motor is (10 closed, 11
  closing, 20 open, 21 opening): the motor wins while it moves.
- `getFLO` is in L/h on these devices (the LEX softeners report L/min, not
  supported). `getCEL` in tenths of °C. `getAVO` in mL.
- The MuCo leak protection modules (firmware "MuCo …") report `getBAR` 0 and
  `getCEL` 0 without the sensors: no pressure nor temperature feature then.
- The Trio answers an unknown command with HTTP 404, not `NSC`.
- `set` answers are `{"setABtrue": "OK"}`, the key case varies: compare
  without case. `MIMA` = value out of range, `NSC` = no such command.
- The Pontos Base reports no `getAB`: no valve control.
- Alarm codes differ by family: `A2` is "no network" on a SafeTech, "motor
  current" on a Trio. The SafeTech family is `/safe-tec`, `/pontos-base` and
  the SafeTech Connect on `/trio` (serial starting with 123).
- `node --test` also runs `test/helpers/`: nothing starts on import.
- An all-digit serial number sorts first in an object: list the devices in
  the order of the typed addresses.
