// -----------------------------------------------------------------------------
// The SYR integration: every handler, registered on a Gladys client.
//
// Brings the SYR leak protection devices of the local network into Gladys,
// through their local JSON API (port 5333):
//   - devices (device.js): one per SYR device: the shut-off valve (switch),
//     leak alarm, alarm text, profile, flow, pressure, temperature, water
//     volumes, battery;
//   - scene triggers (events.js): leak detected, alarm raised and cleared,
//     warning raised, unreachable, back online;
//   - scene actions: select a profile, start the microleak test, reset the
//     alarm, water used;
//   - dashboard widgets (widgets.js): overview (with buttons), water per day;
//   - configuration buttons: search and test, diagnostic.
//
// Pace: a timer reads every device every 10, 30 or 60 s (one request at a
// time per device). Each typed address is recognised once (/trio, then
// /safe-tec, then /pontos-base) and remembered. A device is known by its
// serial number, not by its address.
//
// index.js only creates the SDK client; the tests drive this module with the
// fake Gladys of the SDK and fake devices (test/helpers/fake-syr.js).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { logger as sdkLogger } from '@gladysassistant/integration-sdk';
import {
  normalizeConfig,
  readLanguage,
  guessLanguage,
  INTERNAL_KEYS,
  AUTO_LANGUAGE,
} from './config.js';
import { createSyrClient } from './syr-api.js';
import {
  PATHS,
  parseStatus,
  readStatus,
  setValve,
  setProfile,
  startMicroleakTest,
  clearAlarm,
} from './syr.js';
import { createStore } from './store.js';
import { noteTotal, lastDays, dayOf, litersOf, shiftDay } from './consumption.js';
import {
  deviceIds,
  idOf,
  deviceName,
  alarmText,
  warningText,
  buildDevice,
  buildStates,
  seenFeatures,
} from './device.js';
import {
  TRIGGERS,
  SCENE_ACTIONS,
  OUTPUTS,
  pick,
  rounded,
  detectReachability,
  detectAlarms,
} from './events.js';
import {
  WIDGETS,
  WIDGET_ACTIONS,
  CHART_DAYS,
  messageContent,
  buildOverviewWidget,
  buildConsumptionWidget,
} from './widgets.js';
import { MINUTE_MS, defaultTimeZone, usableTimeZone } from './time.js';
import { t, all, formatNumber, LANGUAGES } from './i18n.js';

const ACTIONS = {
  SEARCH: 'search',
  DIAGNOSTIC: 'diagnostic',
};
const STARTUP_DELAY_MS = 3 * 1000;
// An address that is no SYR device is tried again after this delay.
const RETRY_UNKNOWN_MS = 30 * MINUTE_MS;
// Re-send unchanged values now and then, so that Gladys does not show them as outdated.
const HEARTBEAT_MS = 30 * MINUTE_MS;
const DIAGNOSTIC_CHUNK = 3000;
const { version: VERSION } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

/**
 * @description Register every handler of the integration on a Gladys client.
 * @param {object} gladys - A GladysIntegration (or the fake Gladys of the SDK).
 * @param {object} [options] - Options.
 * @param {Function} [options.request] - HTTP transport of the devices (tests).
 * @param {string} [options.dataDir] - The writable folder (/data).
 * @param {Function} [options.now] - `() => number` in ms (tests).
 * @param {Function} [options.sleep] - `(ms) => Promise` (tests).
 * @param {string} [options.timeZone] - IANA timezone of Gladys (TZ by default).
 * @param {boolean} [options.timers] - Arm the reading timer (false in tests).
 * @param {object} [options.logger] - Logger.
 * @returns {object} Handles for the tests.
 */
function createApp(
  gladys,
  {
    request,
    dataDir,
    now = () => Date.now(),
    sleep,
    timeZone: zone = defaultTimeZone(),
    timers = true,
    logger = sdkLogger,
  } = {},
) {
  const timeZone = usableTimeZone(zone);
  let config = normalizeConfig();
  let language = guessLanguage(timeZone);
  let createdNames = new Map();
  let lastStatus = null;
  let lastDiscovery = null;
  let timer = null;
  let startTimer = null;
  let running = null;
  let stopped = false;
  const clients = new Map();
  const sessions = new Map();
  const notSyr = new Map();
  // Devices whose alarm Gladys just cleared: their "alarm cleared" is ours.
  const commanded = new Map();

  const store = createStore({ ...(dataDir ? { dir: dataDir } : {}), logger });

  /**
   * @description The client of an address (one per address: its queue).
   * @param {string} address - The address.
   * @returns {object} The client.
   */
  function clientOf(address) {
    if (!clients.has(address)) {
      clients.set(
        address,
        createSyrClient({
          address,
          ...(request ? { request } : {}),
          ...(sleep ? { sleep } : {}),
        }),
      );
    }
    return clients.get(address);
  }

  /**
   * @description The expert mode session of an address.
   * @param {string} address - The address.
   * @returns {object} `{ adm, admAt }`.
   */
  function sessionOf(address) {
    if (!sessions.has(address)) sessions.set(address, { adm: null, admAt: 0 });
    return sessions.get(address);
  }

  // In the order of the typed addresses (an all-digit serial number would come
  // first in the object), then the others.
  const devices = () => {
    const rank = (device) => {
      const index = config.hosts.indexOf(device.address);
      return index < 0 ? config.hosts.length : index;
    };
    return Object.values(store.data.devices).sort(
      (a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id),
    );
  };

  /**
   * @description Remember the language of a widget request, and store it when it changed.
   * @param {string} next - The language.
   */
  function rememberLanguage(next) {
    if (!LANGUAGES.includes(next) || next === language) {
      return;
    }
    language = next;
    gladys
      .setConfig({ [INTERNAL_KEYS.language]: next })
      .catch((err) => logger.warn(`Unable to store the language: ${err.message}`));
  }

  /**
   * @description Language of the texts Gladys does not ask for in a language.
   * @returns {string} The language.
   */
  const textLanguage = () => (config.language === AUTO_LANGUAGE ? language : config.language);

  /**
   * @description The name of a device: the one the user gave it in Gladys, else its own.
   * @param {object} device - The stored device.
   * @returns {string} The name.
   */
  const nameOf = (device) =>
    createdNames.get(deviceIds(gladys, device.id).device) || deviceName(device);

  /**
   * @description The device a widget, a scene or a feature points to.
   * @param {unknown} externalId - A `source: "devices"` value or a feature external id.
   * @returns {object|null} The stored device; the first one by default.
   */
  function resolve(externalId) {
    const id = idOf(externalId);
    return (id && store.data.devices[id]) || devices()[0] || null;
  }

  /**
   * @description The water of today and yesterday of a device.
   * @param {object} device - The stored device.
   * @returns {{ today: number|null, yesterday: number|null }} Liters.
   */
  function usageOf(device) {
    const today = dayOf(now(), timeZone);
    return {
      today: litersOf(device.usage, today, today),
      yesterday: litersOf(device.usage, shiftDay(today, -1), today),
    };
  }

  // --- Errors and status -------------------------------------------------------------

  /**
   * @description The message of an error, for a user.
   * @param {object} err - The error (`kind`, `address`, `code`).
   * @param {string} lang - The language.
   * @returns {string} The message.
   */
  function errorText(err, lang) {
    if (err?.kind === 'refused') return t('errRefused', lang, { code: err.code ?? '' });
    const key = { unreachable: 'errUnreachable', invalid: 'errNotSyr', http: 'errNotSyr' }[
      err?.kind
    ];
    if (key) {
      return t(key, lang, { address: err.address ?? '' });
    }
    return t('errFailed', lang, { detail: String(err?.message ?? '').slice(0, 120) });
  }

  /**
   * @description Report the connection status, only when it changed.
   * @param {boolean} connected - Connected or not.
   * @param {object} message - The multi-language message.
   * @returns {Promise<void>}
   */
  async function reportStatus(connected, message) {
    const clipped = Object.fromEntries(
      Object.entries(message).map(([lang, text]) => [lang, text.slice(0, 200)]),
    );
    const signature = JSON.stringify([connected, clipped]);
    if (signature === lastStatus) {
      return;
    }
    lastStatus = signature;
    try {
      await gladys.setConnectionStatus(connected, clipped);
    } catch (err) {
      lastStatus = null;
      logger.error('Unable to report the connection status', err);
    }
  }

  /**
   * @description Work out the connection status.
   * @returns {Promise<void>}
   */
  async function refreshStatus() {
    const list = devices().filter((device) => config.hosts.includes(device.address));
    if (!config.hosts.length) {
      await reportStatus(false, all('statusNoHosts'));
      return;
    }
    if (!list.length) {
      const error = store.data.lastError;
      await reportStatus(
        false,
        all((lang) => (error ? errorText(error, lang) : t('statusNoDevice', lang))),
      );
      return;
    }
    const down = list.filter((device) => device.seen?.down);
    const names = (entries) => entries.map((device) => nameOf(device)).join(', ');
    if (down.length === list.length) {
      await reportStatus(false, all('statusDown', { names: names(down) }));
      return;
    }
    await reportStatus(
      true,
      all((lang) =>
        [
          t('statusOk', lang, { count: list.length, names: names(list) }),
          ...(down.length ? [t('statusSomeDown', lang, { names: names(down) })] : []),
        ].join(' '),
      ),
    );
  }

  /**
   * @description Refresh the devices the user created, and their names.
   * @returns {Promise<void>}
   */
  async function refreshCreatedDevices() {
    try {
      const list = await gladys.getDevices();
      createdNames = new Map(list.map((device) => [device.external_id, device.name ?? '']));
    } catch (err) {
      logger.warn(`Unable to read the devices: ${err.message}`);
    }
  }

  /**
   * @description Ask the open widgets to pull their content again.
   */
  function refreshWidgets() {
    for (const key of Object.values(WIDGETS)) {
      Promise.resolve(gladys.requestWidgetRefresh(key)).catch(() => {});
    }
  }

  /**
   * @description Publish scene events, one by one.
   * @param {Array<{ key: string, data: object }>} events - The events.
   * @returns {Promise<void>}
   */
  async function publishEvents(events) {
    for (const { key, data } of events) {
      logger.info(`SYR: ${key} (${data.device_name})`);
      try {
        await gladys.publishSceneEvent(key, data);
      } catch (err) {
        logger.warn(`Unable to fire ${key}: ${err.message}`);
      }
    }
  }

  // --- Devices -----------------------------------------------------------------------

  /**
   * @description Offer the devices, when they changed.
   * @param {boolean} [force] - Publish even when unchanged.
   * @returns {Promise<number>} How many devices were offered.
   */
  async function publishDiscoveredDevices(force = false) {
    const lang = textLanguage();
    const list = devices()
      .map((device) => buildDevice(gladys, device, { language: lang }))
      .filter(Boolean);
    const signature = JSON.stringify(list);
    if (force || signature !== lastDiscovery) {
      await gladys.publishDiscoveredDevices(list);
      lastDiscovery = signature;
    }
    return list.length;
  }

  /**
   * @description Publish the states of the created devices.
   * @returns {Promise<void>}
   */
  async function publishAllStates() {
    const lang = textLanguage();
    for (const device of devices()) {
      if (device.seen?.down || !createdNames.has(deviceIds(gladys, device.id).device)) {
        // Unreachable: the values age, Gladys shows them as outdated.
        continue;
      }
      const states = buildStates(gladys, device, {
        language: lang,
        todayLiters: usageOf(device).today,
      });
      if (!states.length) continue;
      await gladys
        .publishChangedStates(states, { heartbeat: HEARTBEAT_MS })
        .catch((err) =>
          logger.warn(`Unable to publish the states of ${device.id}: ${err.message}`),
        );
    }
  }

  // --- Reading -----------------------------------------------------------------------

  /**
   * @description Note an error.
   * @param {Error} err - The error.
   * @param {string} address - The address.
   */
  function noteError(err, address) {
    const kind = err.kind ?? 'failed';
    logger.warn(`SYR ${address} (${kind}): ${err.message}`);
    store.data.lastError = { kind, address, message: String(err.message).slice(0, 200), at: now() };
  }

  /**
   * @description Read an address on the path it is known on, or find its path.
   * @param {string} address - The address.
   * @returns {Promise<object>} The snapshot (parseStatus).
   */
  async function snapshotOf(address) {
    const client = clientOf(address);
    const session = sessionOf(address);
    const known = store.data.addresses[address];
    if (known) {
      try {
        return parseStatus(await readStatus(client, known, session, now()), known);
      } catch (err) {
        // Unreachable: the same path, later. Another answer: look again.
        if (err.kind === 'unreachable') throw err;
      }
    }
    let last = null;
    for (const path of PATHS) {
      if (path === known) continue;
      try {
        const snapshot = parseStatus(await readStatus(client, path, session, now()), path);
        store.data.addresses[address] = path;
        logger.info(`SYR device found at ${address}${path}: ${snapshot.model}`);
        return snapshot;
      } catch (err) {
        if (err.kind === 'unreachable') throw err;
        last = err;
      }
    }
    delete store.data.addresses[address];
    throw Object.assign(last ?? new Error('not a SYR device'), { kind: 'invalid' });
  }

  /**
   * @description Read one address.
   * @param {string} address - The address.
   * @param {Set<string>} done - The devices already read this round.
   * @param {Array} events - Where the scene events go.
   * @returns {Promise<{ id: string|null, error: object|null }>} What happened.
   */
  async function readAddress(address, done, events) {
    let snapshot;
    try {
      snapshot = await snapshotOf(address);
    } catch (err) {
      err.address = address;
      noteError(err, address);
      if (err.kind === 'invalid' && !devices().some((device) => device.address === address)) {
        notSyr.set(address, now() + RETRY_UNKNOWN_MS);
      }
      return { id: null, error: err };
    }
    if (!snapshot.id || done.has(snapshot.id)) {
      return { id: snapshot.id, error: null };
    }
    done.add(snapshot.id);
    const known = Boolean(store.data.devices[snapshot.id]);
    const device = (store.data.devices[snapshot.id] ??= {
      id: snapshot.id,
      values: {},
      present: {},
      usage: { days: {} },
    });
    const before = known ? device.values : null;
    const { id, ...values } = snapshot;
    Object.assign(device, {
      address,
      path: snapshot.path,
      serial: snapshot.serial,
      model: snapshot.model,
      firmware: snapshot.firmware,
      readAt: now(),
    });
    device.values = values;
    for (const key of seenFeatures(values)) device.present[key] = true;
    noteTotal(device.usage, values.totalL, now(), timeZone);
    const ours = commanded.get(id) > now();
    for (const event of detectAlarms(before, values)) {
      if (event.key === TRIGGERS.ALARM_CLEARED && ours) continue;
      const lang = textLanguage();
      const name = nameOf(device);
      const textOf = event.data.alarm
        ? alarmText({ alarm: event.data.alarm, alarmCode: event.data.code }, lang)
        : warningText({ warning: event.data.warning, warningCode: event.data.code }, lang);
      events.push({
        key: event.key,
        data: {
          device: deviceIds(gladys, id).device,
          device_name: name.slice(0, 200),
          code: event.data.code,
          ...(event.key === TRIGGERS.WARNING
            ? { warning: textOf.slice(0, 200) }
            : { alarm: textOf.slice(0, 200), leak: event.data.leak }),
          ...(event.key === TRIGGERS.WARNING ? {} : { valve_closed: Boolean(values.closed) }),
          message: t(`event_${event.key}`, lang, { name, text: textOf }).slice(0, 1000),
        },
      });
    }
    if (!known) {
      logger.info(`SYR ${snapshot.model} ${id} at ${address}${snapshot.path}`);
    }
    return { id, error: null };
  }

  /**
   * @description One reading round of every device.
   * @returns {Promise<{ found: string[], errors: object[] }>} The devices read and the errors.
   */
  async function runReading() {
    const done = new Set();
    const errors = [];
    const events = [];
    const typed = config.hosts.filter((address) => !(notSyr.get(address) > now()));
    for (const address of typed) {
      const result = await readAddress(address, done, events);
      if (result.error) errors.push(result.error);
    }
    // Reachability, once per device of a typed address.
    for (const device of devices()) {
      if (!config.hosts.includes(device.address)) continue;
      const found = detectReachability(device.seen, { ok: done.has(device.id), now: now() });
      device.seen = found.next;
      for (const event of found.events) {
        const lang = textLanguage();
        events.push({
          key: event.key,
          data: {
            device: deviceIds(gladys, device.id).device,
            device_name: nameOf(device).slice(0, 200),
            address: device.address ?? '',
            ...event.data,
            message: t(`event_${event.key}`, lang, { name: nameOf(device) }).slice(0, 1000),
          },
        });
      }
    }
    for (const [key, until] of commanded) {
      if (until <= now()) commanded.delete(key);
    }
    if (done.size && !errors.length) store.data.lastError = null;
    await store.save();
    await publishDiscoveredDevices().catch((err) =>
      logger.warn(`Unable to offer the devices: ${err.message}`),
    );
    await publishAllStates();
    if (events.length) await publishEvents(events);
    refreshWidgets();
    await refreshStatus();
    return { found: [...done], errors };
  }

  /**
   * @description One round of the timer (never two at once).
   * @returns {Promise<void>}
   */
  function tick() {
    if (!running) {
      running = runReading()
        .catch((err) => logger.error('Readings', err))
        .finally(() => {
          running = null;
        });
    }
    return running;
  }

  /**
   * @description (Re)arm the reading timer.
   */
  function schedule() {
    clearInterval(timer);
    clearTimeout(startTimer);
    if (!timers || stopped) {
      return;
    }
    startTimer = setTimeout(tick, STARTUP_DELAY_MS);
    startTimer.unref?.();
    timer = setInterval(tick, config.interval * 1000);
    timer.unref?.();
  }

  /**
   * @description Offer the devices, publish what is known, arm the timer.
   * @returns {Promise<void>}
   */
  async function applyConfig() {
    await store.save();
    await publishDiscoveredDevices().catch((err) =>
      logger.warn(`Unable to offer the devices: ${err.message}`),
    );
    await publishAllStates();
    await refreshStatus();
    schedule();
  }

  // --- Commands ----------------------------------------------------------------------

  /**
   * @description Run a command on a device, then read it again.
   * @param {object} device - The stored device.
   * @param {Function} run - `(client, values) => Promise`.
   * @param {string} label - For the logs.
   * @returns {Promise<void>}
   */
  async function command(device, run, label) {
    const lang = textLanguage();
    if (device.seen?.down) {
      throw new Error(t('errDown', lang, { name: nameOf(device) }));
    }
    const client = clientOf(device.address);
    try {
      await run(client, { ...device.values, path: device.path });
    } catch (err) {
      err.address ??= device.address;
      throw new Error(errorText(err, lang), { cause: err });
    }
    logger.info(`SYR ${device.id}: ${label}`);
    await tick();
  }

  const openValve = (device, open) =>
    command(device, (client, values) => setValve(client, values, !open), open ? 'open' : 'close');

  /**
   * @description Select a profile, after checking it is one of the device.
   * @param {object} device - The stored device.
   * @param {number} number - 1 to 8.
   * @returns {Promise<object>} The profile `{ number, name }`.
   */
  async function selectProfile(device, number) {
    const profile = (device.values?.profiles ?? []).find((entry) => entry.number === number);
    if (!profile) {
      throw new Error(t('errNoProfile', textLanguage(), { n: number }));
    }
    await command(
      device,
      (client, values) => setProfile(client, values, number),
      `profile ${number}`,
    );
    return profile;
  }

  /**
   * @description Clear the alarm of a device, without firing "alarm cleared".
   * @param {object} device - The stored device.
   * @returns {Promise<void>}
   */
  function resetAlarm(device) {
    commanded.set(device.id, now() + 3 * config.interval * 1000);
    return command(device, (client, values) => clearAlarm(client, values), 'alarm reset');
  }

  const microleakTest = (device) =>
    command(device, (client, values) => startMicroleakTest(client, values), 'microleak test');

  gladys.onSetValue(async (gladysDevice, deviceFeature, value) => {
    const featureId = deviceFeature?.external_id ?? '';
    const id = idOf(featureId);
    const device = id ? store.data.devices[id] : null;
    if (!device) throw new Error(t('errNoDevice', textLanguage()));
    if (featureId.endsWith(':valve')) {
      await openValve(device, Number(value) >= 1);
      return;
    }
    if (featureId.endsWith(':profile')) {
      await selectProfile(device, Math.round(Number(value)));
      return;
    }
    throw new Error(`${featureId} is read only`);
  });

  // --- Dashboard widgets -------------------------------------------------------------

  /**
   * @description The message a widget shows when there is no device.
   * @param {string} lang - The language.
   * @returns {object|null} The content, null when there are devices.
   */
  function widgetMessage(lang) {
    if (devices().length) return null;
    if (!config.hosts.length) return messageContent(t('statusNoHosts', lang));
    const error = store.data.lastError;
    return messageContent(error ? errorText(error, lang) : t('statusNoDevice', lang));
  }

  gladys.onWidgetGet(WIDGETS.OVERVIEW, async ({ settings = {}, language: lang } = {}) => {
    rememberLanguage(lang);
    const message = widgetMessage(lang);
    if (message) return message;
    const device = resolve(settings.device);
    return buildOverviewWidget({
      device,
      name: nameOf(device),
      todayLiters: usageOf(device).today,
      language: lang,
      now: now(),
    });
  });

  gladys.onWidgetGet(WIDGETS.CONSUMPTION, async ({ settings = {}, language: lang } = {}) => {
    rememberLanguage(lang);
    const message = widgetMessage(lang);
    if (message) return message;
    const device = resolve(settings.device);
    return buildConsumptionWidget({
      device,
      name: nameOf(device),
      days: lastDays(device.usage, CHART_DAYS, now(), timeZone),
      language: lang,
    });
  });

  gladys.onWidgetAction(WIDGETS.OVERVIEW, async (actionKey, params = {}) => {
    const device = store.data.devices[params.device];
    if (!device) throw new Error(t('errNoDevice', textLanguage()));
    const toast = (key) => all((l) => t(key, l, { name: nameOf(device) }).slice(0, 200));
    switch (actionKey) {
      case WIDGET_ACTIONS.CLOSE_VALVE:
        await openValve(device, false);
        return toast('toastClosed');
      case WIDGET_ACTIONS.OPEN_VALVE:
        await openValve(device, true);
        return toast('toastOpened');
      case WIDGET_ACTIONS.RESET_ALARM:
        await resetAlarm(device);
        return toast('toastReset');
      case WIDGET_ACTIONS.MICROLEAK_TEST:
        await microleakTest(device);
        return toast('toastTest');
      default:
        throw new Error(`unknown action ${actionKey}`);
    }
  });

  // --- Scene actions -----------------------------------------------------------------

  /**
   * @description The device of a scene action.
   * @param {object} fields - The fields.
   * @returns {object} The stored device.
   */
  function sceneDevice(fields) {
    const device = resolve(fields.device);
    if (!device) throw new Error(t('errNoDevice', textLanguage()));
    return device;
  }

  gladys.onSceneAction(SCENE_ACTIONS.SET_PROFILE, async (fields = {}) => {
    const device = sceneDevice(fields);
    const profile = await selectProfile(device, Math.round(Number(fields.profile)));
    const name = nameOf(device);
    return pick(
      {
        device_name: name,
        profile: profile.number,
        profile_name: profile.name,
        summary: t('summaryProfile', textLanguage(), { name, profile: profile.name }).slice(
          0,
          1000,
        ),
      },
      OUTPUTS.set_profile,
    );
  });

  gladys.onSceneAction(SCENE_ACTIONS.MICROLEAK_TEST, async (fields = {}) => {
    const device = sceneDevice(fields);
    await microleakTest(device);
    const name = nameOf(device);
    return pick(
      {
        device_name: name,
        summary: t('summaryTest', textLanguage(), { name }).slice(0, 1000),
      },
      OUTPUTS.start_microleak_test,
    );
  });

  gladys.onSceneAction(SCENE_ACTIONS.RESET_ALARM, async (fields = {}) => {
    const device = sceneDevice(fields);
    const lang = textLanguage();
    const previous = alarmText(device.values, lang);
    const name = nameOf(device);
    if (device.values?.alarmCode) await resetAlarm(device);
    return pick(
      {
        device_name: name,
        previous_alarm: previous,
        summary: (previous
          ? t('summaryReset', lang, { name, alarm: previous })
          : t('summaryNoAlarm', lang, { name })
        ).slice(0, 1000),
      },
      OUTPUTS.reset_alarm,
    );
  });

  gladys.onSceneAction(SCENE_ACTIONS.GET_CONSUMPTION, async (fields = {}) => {
    const device = sceneDevice(fields);
    const lang = textLanguage();
    const values = device.values ?? {};
    const { today, yesterday } = usageOf(device);
    const name = nameOf(device);
    const format = (value, decimals = 0) =>
      Number.isFinite(value) ? formatNumber(value, lang, decimals) : '–';
    const total = Number.isFinite(values.totalL) ? rounded(values.totalL / 1000, 3) : null;
    return pick(
      {
        device_name: name,
        today_liters: rounded(today, 0),
        yesterday_liters: rounded(yesterday, 0),
        total_m3: total,
        flow_lpm: Number.isFinite(values.flowLh) ? rounded(values.flowLh / 60, 1) : null,
        valve_open: typeof values.closed === 'boolean' ? !values.closed : null,
        summary: t('summaryConsumption', lang, {
          name,
          today: format(today),
          yesterday: format(yesterday),
          total: format(total, 1),
        }).slice(0, 1000),
      },
      OUTPUTS.get_consumption,
    );
  });

  // --- Configuration screen actions --------------------------------------------------

  gladys.onAction(ACTIONS.SEARCH, async () => {
    notSyr.clear();
    const { found, errors } = await runReading();
    lastStatus = null;
    await refreshStatus();
    await publishDiscoveredDevices(true).catch((err) =>
      logger.warn(`Unable to offer the devices: ${err.message}`),
    );
    if (!config.hosts.length) return all('statusNoHosts');
    if (!found.length) {
      const error = errors[0];
      return all((lang) =>
        (error ? errorText(error, lang) : t('statusNoDevice', lang)).slice(0, 1000),
      );
    }
    return all((lang) => {
      const names = found.map((id) => nameOf(store.data.devices[id])).join(', ');
      const problems = errors.map((err) => errorText(err, lang));
      return [t('searchOk', lang, { count: found.length, names }), ...problems]
        .join(' ')
        .slice(0, 1000);
    });
  });

  gladys.onAction(ACTIONS.DIAGNOSTIC, async () => {
    const iso = (value) => (Number.isFinite(value) && value ? new Date(value).toISOString() : null);
    const report = {
      version: VERSION,
      timeZone,
      hosts: config.hosts,
      interval: config.interval,
      language: config.language,
      addresses: store.data.addresses,
      sessions: Object.fromEntries(sessions),
      lastError: store.data.lastError,
      clients: Object.fromEntries(
        [...clients].map(([address, client]) => [address, client.counts()]),
      ),
      devices: devices().map((device) => ({
        id: device.id,
        model: device.model,
        firmware: device.firmware ?? null,
        address: device.address,
        path: device.path,
        readAt: iso(device.readAt),
        seen: device.seen,
        values: device.values,
        present: device.present,
        usageDays: Object.keys(device.usage?.days ?? {}).length,
        created: createdNames.has(deviceIds(gladys, device.id).device),
      })),
    };
    const json = JSON.stringify(report);
    const count = Math.max(1, Math.ceil(json.length / DIAGNOSTIC_CHUNK));
    for (let chunk = 0; chunk < count; chunk += 1) {
      logger.info(
        `SYR diagnostic ${chunk + 1}/${count}: ${json.slice(chunk * DIAGNOSTIC_CHUNK, (chunk + 1) * DIAGNOSTIC_CHUNK)}`,
      );
    }
    return all('diagnosticDone', { count });
  });

  // --- Devices -----------------------------------------------------------------------
  gladys.onScanRequest(async () => {
    notSyr.clear();
    await runReading();
    const count = await publishDiscoveredDevices(true);
    logger.info(`Scan: ${count} device(s) offered`);
  });

  gladys.onDeviceCreated(async () => {
    await refreshCreatedDevices();
    // States sent before the device existed were dropped by Gladys, and the SDK
    // forgot what it sent for this device: send everything known again.
    await publishAllStates();
    refreshWidgets();
  });

  gladys.onDeviceUpdated(refreshCreatedDevices);
  gladys.onDeviceDeleted(refreshCreatedDevices);

  // --- Configuration -----------------------------------------------------------------

  /**
   * @description Reload the whole config (internal keys included).
   * @param {object} [fallback] - Raw values to use when the read fails.
   * @returns {Promise<void>}
   */
  async function loadConfig(fallback) {
    try {
      const raw = await gladys.getConfig();
      config = normalizeConfig(raw);
      language = readLanguage(raw, language);
    } catch (err) {
      if (fallback) {
        config = normalizeConfig(fallback);
      }
      logger.error('Unable to read the configuration', err);
    }
  }

  gladys.onConfigUpdated(async (rawConfig) => {
    const previous = config;
    await loadConfig(rawConfig);
    logger.info('Configuration updated');
    lastStatus = null;
    lastDiscovery = null;
    if (previous.hosts.join() !== config.hosts.join()) {
      notSyr.clear();
    }
    await applyConfig();
  });

  // --- Connection lifecycle ----------------------------------------------------------
  // Each (re)connection resynchronizes; the promise lets the tests wait for it.
  let startup = Promise.resolve();
  gladys.on('connected', () => {
    startup = (async () => {
      await store.load();
      await loadConfig();
      await refreshCreatedDevices();
      lastStatus = null;
      lastDiscovery = null;
      await applyConfig();
    })().catch((err) => logger.error('Startup', err));
  });

  // --- Graceful shutdown -------------------------------------------------------------
  gladys.handleShutdown(async (signal) => {
    logger.info(`Received ${signal} -> graceful shutdown`);
    stopped = true;
    clearInterval(timer);
    clearTimeout(startTimer);
    await running?.catch(() => {});
    await store.save();
  });

  return {
    store,
    tick,
    runReading,
    resolve,
    openValve,
    selectProfile,
    resetAlarm,
    getConfig: () => config,
    whenReady: () => startup,
  };
}

export { createApp, ACTIONS, HEARTBEAT_MS, RETRY_UNKNOWN_MS };
