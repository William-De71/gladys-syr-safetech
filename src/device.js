// -----------------------------------------------------------------------------
// The Gladys device of a SYR leak protection device: one device per SYR device,
// `ext:<selector>:syr:<serial>` (the serial number in lower case, letters and
// digits only), with the features it reports:
//
//   valve           switch / binary, writable: 1 = water flows (valve open),
//                   0 = shut off; has_feedback (read back from getVLV/getAB)
//   leak            leak-sensor / binary: 1 while a leak alarm is active
//   alarm           text / text: the current alarm, in words ("" when none)
//   profile         text / select, writable: the leak protection profile, the
//                   options are the active profiles of the device (their names)
//   flow            water-valve / flow (m³/h)
//   pressure        pressure-sensor / decimal (bar)
//   temperature     temperature-sensor / decimal (°C, water)
//   total_volume    volume-sensor / decimal (m³, the meter of the device)
//   today_volume    volume-sensor / decimal (liters since midnight, worked out
//                   by the integration)
//   last_volume     volume-sensor / decimal (liters of the last water draw)
//   current_volume  volume-sensor / decimal (liters of the draw going on)
//   battery         battery / integer (%), when the device tells it
//   battery_low     battery-low / binary
//
// A feature appears once its value was seen (no pressure sensor on a Trio
// DFR/LS, no battery level on a SafeTech), and then stays.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { t } from './i18n.js';

const DEVICE_TYPE = 'syr';

const FEATURES = {
  valve: {
    category: C.SWITCH,
    type: T.SWITCH.BINARY,
    unit: null,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: true,
  },
  leak: { category: C.LEAK_SENSOR, type: T.SENSOR.BINARY, unit: null, min: 0, max: 1 },
  alarm: { category: C.TEXT, type: T.TEXT.TEXT, unit: null, min: 0, max: 0, history: false },
  profile: {
    category: C.TEXT,
    type: T.TEXT.SELECT,
    unit: null,
    min: 0,
    max: 0,
    read_only: false,
    has_feedback: true,
    history: false,
  },
  flow: {
    category: C.WATER_VALVE,
    type: T.WATER_VALVE.FLOW,
    unit: U.CUBIC_METER_PER_HOUR,
    min: 0,
    max: 100,
  },
  pressure: {
    category: C.PRESSURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.BAR,
    min: 0,
    max: 25,
  },
  temperature: {
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: 0,
    max: 100,
  },
  total_volume: {
    category: C.VOLUME_SENSOR,
    type: T.VOLUME_SENSOR.DECIMAL,
    unit: U.CUBIC_METER,
    min: 0,
    max: 10000000,
  },
  today_volume: {
    category: C.VOLUME_SENSOR,
    type: T.VOLUME_SENSOR.DECIMAL,
    unit: U.LITER,
    min: 0,
    max: 1000000,
  },
  last_volume: {
    category: C.VOLUME_SENSOR,
    type: T.VOLUME_SENSOR.DECIMAL,
    unit: U.LITER,
    min: 0,
    max: 1000000,
  },
  current_volume: {
    category: C.VOLUME_SENSOR,
    type: T.VOLUME_SENSOR.DECIMAL,
    unit: U.LITER,
    min: 0,
    max: 1000000,
  },
  battery: { category: C.BATTERY, type: T.BATTERY.INTEGER, unit: U.PERCENT, min: 0, max: 100 },
  battery_low: { category: C.BATTERY_LOW, type: T.BATTERY_LOW.BINARY, unit: null, min: 0, max: 1 },
};

// The order the features are offered in.
const FEATURE_KEYS = Object.keys(FEATURES);

/**
 * @description The ids of a device.
 * @param {object} gladys - The GladysIntegration instance.
 * @param {string} id - The serial number id.
 * @returns {{ device: string, feature: Function }} The ids.
 */
const deviceIds = (gladys, id) => gladys.externalIds(DEVICE_TYPE, id);

/**
 * @description The device a device external id (or a feature id) points to.
 * @param {unknown} externalId - `ext:…:syr:112aaa12345` (or `…:valve`).
 * @returns {string|null} The serial number id.
 */
function idOf(externalId) {
  const match = String(externalId ?? '').match(/:syr:([0-9a-z]{1,32})(?::[a-z_]+)?$/);
  return match ? match[1] : null;
}

/**
 * @description The default name of a device: "SYR SafeTech Plus Connect 112AAA12345".
 * @param {object} device - The stored device.
 * @returns {string} The name.
 */
function deviceName(device) {
  const model = String(device.model ?? 'SYR Connect');
  const prefix = /^(SYR|Hansgrohe|RWC|CONEL|Sanibel|DITECH|TAKE|concept|Optima)\b/i.test(model)
    ? ''
    : 'SYR ';
  return `${prefix}${model} ${String(device.serial ?? device.id).toUpperCase()}`.trim();
}

/**
 * @description The keys of the features a device has shown so far.
 * @param {object} device - The stored device.
 * @returns {string[]} The keys, in the offered order.
 */
function featureKeys(device) {
  return FEATURE_KEYS.filter((key) => device.present?.[key]);
}

/**
 * @description The options of the profile select.
 * @param {object} device - The stored device.
 * @returns {Array<{ value: string, label: string, sort_order: number }>} The options.
 */
function profileOptions(device) {
  return (device.values?.profiles ?? []).map((profile, index) => ({
    value: String(profile.number),
    label: profile.name,
    sort_order: index,
  }));
}

/**
 * @description One feature.
 * @param {Function} id - `feature(key)` of the device ids.
 * @param {string} key - The feature key.
 * @param {object} device - The stored device (options of the select).
 * @param {string} language - The language of the name.
 * @returns {object} The feature.
 */
function feature(id, key, device, language) {
  const spec = FEATURES[key];
  return {
    name: t(`feature_${key}`, language),
    external_id: id(key),
    category: spec.category,
    type: spec.type,
    unit: spec.unit,
    min: spec.min,
    max: spec.max,
    read_only: spec.read_only ?? true,
    has_feedback: spec.has_feedback ?? false,
    keep_history: spec.history ?? true,
    ...(key === 'profile' ? { supported_options: profileOptions(device) } : {}),
  };
}

/**
 * @description The Gladys device of a SYR device.
 * @param {object} gladys - The GladysIntegration instance.
 * @param {object} device - The stored device.
 * @param {object} [options] - `{ language }`.
 * @returns {object|null} The discovered device, null without any feature yet.
 */
function buildDevice(gladys, device, { language = 'en' } = {}) {
  const ids = deviceIds(gladys, device.id);
  const keys = featureKeys(device);
  if (!keys.length) return null;
  return {
    name: deviceName(device),
    external_id: ids.device,
    model: String(device.model ?? 'SYR Connect'),
    should_poll: false,
    params: [
      { name: 'SYR_SERIAL', value: String(device.serial ?? device.id) },
      { name: 'SYR_PATH', value: String(device.path ?? '') },
      { name: 'SYR_ADDRESS', value: String(device.address ?? '') },
    ],
    features: keys.map((key) => feature(ids.feature, key, device, language)),
  };
}

const round = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};
const bounded = (value, key) => Math.min(FEATURES[key].max, Math.max(FEATURES[key].min, value));

/**
 * @description The text of an alarm.
 * @param {object} values - The device values (`alarm`, `alarmCode`).
 * @param {string} language - The language.
 * @returns {string} The text, "" without an alarm.
 */
function alarmText(values, language) {
  if (!values?.alarm) return '';
  if (values.alarm === 'other') return t('alarm_other', language, { code: values.alarmCode });
  return t(`alarm_${values.alarm}`, language);
}

/**
 * @description The text of a warning.
 * @param {object} values - The device values (`warning`, `warningCode`).
 * @param {string} language - The language.
 * @returns {string} The text, "" without a warning.
 */
function warningText(values, language) {
  if (!values?.warning) return '';
  if (values.warning === 'other') return t('warning_other', language, { code: values.warningCode });
  return t(`warning_${values.warning}`, language);
}

/**
 * @description The name of the current profile.
 * @param {object} values - The device values.
 * @returns {string|null} The name.
 */
function profileName(values) {
  const found = (values?.profiles ?? []).find((profile) => profile.number === values?.profile);
  return found ? found.name : Number.isFinite(values?.profile) ? String(values.profile) : null;
}

/**
 * @description The states of a device; an unknown value is left untouched.
 * @param {object} gladys - The GladysIntegration instance.
 * @param {object} device - The stored device.
 * @param {object} [options] - `{ language, todayLiters }`.
 * @returns {object[]} `{ device_feature_external_id, state | text }`.
 */
function buildStates(gladys, device, { language = 'en', todayLiters = null } = {}) {
  const states = [];
  const values = device.values ?? {};
  const ids = deviceIds(gladys, device.id);
  const push = (key, value, decimals) => {
    if (Number.isFinite(value) && device.present?.[key]) {
      states.push({
        device_feature_external_id: ids.feature(key),
        state: bounded(round(value, decimals), key),
      });
    }
  };
  const pushText = (key, text) => {
    if (typeof text === 'string' && device.present?.[key]) {
      states.push({ device_feature_external_id: ids.feature(key), text: text.slice(0, 250) });
    }
  };
  if (typeof values.closed === 'boolean') push('valve', values.closed ? 0 : 1, 0);
  push('leak', values.leak ? 1 : 0, 0);
  pushText('alarm', alarmText(values, language) || t('alarm_none', language));
  if (Number.isFinite(values.profile)) pushText('profile', String(values.profile));
  push('flow', Number.isFinite(values.flowLh) ? values.flowLh / 1000 : null, 3);
  push('pressure', values.pressureBar, 2);
  push('temperature', values.temperatureC, 1);
  push('total_volume', Number.isFinite(values.totalL) ? values.totalL / 1000 : null, 3);
  push('today_volume', todayLiters, 0);
  push('last_volume', values.lastL, 1);
  push('current_volume', values.currentL, 1);
  push('battery', values.batteryPercent, 0);
  push('battery_low', values.batteryLow ? 1 : 0, 0);
  return states;
}

/**
 * @description The features a snapshot shows.
 * @param {object} values - The device values (parseStatus).
 * @returns {string[]} The keys.
 */
function seenFeatures(values) {
  const seen = ['leak', 'alarm', 'battery_low'];
  if (typeof values.closed === 'boolean' && values.valveFormat) seen.push('valve');
  if (values.profiles?.length && Number.isFinite(values.profile)) seen.push('profile');
  if (Number.isFinite(values.flowLh)) seen.push('flow');
  if (Number.isFinite(values.pressureBar)) seen.push('pressure');
  if (Number.isFinite(values.temperatureC)) seen.push('temperature');
  if (Number.isFinite(values.totalL)) seen.push('total_volume', 'today_volume');
  if (Number.isFinite(values.lastL)) seen.push('last_volume');
  if (Number.isFinite(values.currentL)) seen.push('current_volume');
  if (Number.isFinite(values.batteryPercent)) seen.push('battery');
  return seen;
}

export {
  DEVICE_TYPE,
  FEATURES,
  FEATURE_KEYS,
  deviceIds,
  idOf,
  deviceName,
  featureKeys,
  profileOptions,
  alarmText,
  warningText,
  profileName,
  buildDevice,
  buildStates,
  seenFeatures,
};
