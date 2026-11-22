// -----------------------------------------------------------------------------
// The local JSON API of the SYR leak protection devices: which path a device
// answers on, its values in one shape, and its commands.
//
// Facts read from the community documentation of the API, not from SYR (no
// code reused):
//   - alexhass/syr_connect (Apache-2.0): docs/syrconnect-protocol.md,
//     docs/known_issues_json_api.md, the device captures of tests/fixtures/json;
//   - ahornung/syr-safetech-connect-api (MIT): the SafeTech fields.
//
// Three families of paths, tried in this order and remembered per address:
//   /trio         newer devices: SafeTech Connect (2023+), SafeTech Plus,
//                 Trio DFR/LS, Trio LS, SafeTech Lock, TRIO Lock and the
//                 twins of other brands (CONEL, Sanibel, DITECH, TAKE, concept,
//                 Optima). Native JSON types: getAB false, getBAR 4101 (mbar).
//   /safe-tec     older SafeTech V3/V4 Connect, RWC MultiSafe: strings with
//                 units ("4900 mbar", "Vol[L]1885", "9,36", "0mL"), getAB 1/2.
//   /pontos-base  Hansgrohe Pontos Base: like /safe-tec.
// The older firmwares report every value only after /set/ADM/(2)f (else
// "ERROR: ADM"); the newer ones answer that path with 404 (not needed).
//
// Commands (URL paths in lower case, response keys compared without case):
//   valve      /set/ab/true|false (newer), /set/ab/2|1 (older): closed|open
//   profile    /set/prf/<n>
//   microleak  /set/dex/true (getTYP >= 100 or none), /set/dex/1 (older)
//   alarm      /set/ala/255 (newer), /clr/ala (SafeTech family)
// -----------------------------------------------------------------------------

import { SyrError } from './syr-api.js';

const PATHS = ['/trio', '/safe-tec', '/pontos-base'];
const ADM_PATHS = ['/safe-tec', '/pontos-base'];
// The expert mode is sent again after this delay (the firmwares are not known to leave it).
const ADM_EVERY_MS = 30 * 60 * 1000;
const PROFILE_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8];

// Valve motor (getVLV).
const VALVE = { CLOSED: 10, CLOSING: 11, OPEN: 20, OPENING: 21 };
const VALVE_STATES = {
  [VALVE.CLOSED]: 'closed',
  [VALVE.CLOSING]: 'closing',
  [VALVE.OPEN]: 'open',
  [VALVE.OPENING]: 'opening',
};

// Values that mean "no code" (after trim + upper case).
const NO_CODE = new Set(['', '0', '00', 'FF', '255']);

// Alarm codes (getALA) -> key of their meaning (texts in i18n-texts.js as `alarm_<key>`).
// The SafeTech family (/safe-tec, /pontos-base, the SafeTech Connect on /trio) has
// its own table; the other /trio devices share the "common" one.
const ALARMS = {
  safetech: {
    A1: 'end_switch',
    A2: 'no_network',
    A3: 'leak_volume',
    A4: 'leak_time',
    A5: 'max_flow',
    A6: 'microleak',
    A7: 'external_sensor',
    A8: 'turbine_blocked',
    A9: 'pressure_sensor',
    AA: 'temperature_sensor',
    AB: 'conductivity_sensor',
    AC: 'conductivity_high',
    AD: 'battery_low',
    AE: 'leak_volume_soon',
    AF: 'no_power',
  },
  common: {
    '01': 'pressure_low',
    '02': 'pressure_high',
    '0E': 'valve_position',
    96: 'leak_volume_no_shutoff',
    97: 'leak_time_no_shutoff',
    '9F': 'end_switch',
    A0: 'leak_protection_link',
    A1: 'end_switch',
    A2: 'motor_current',
    A3: 'leak_volume',
    A4: 'leak_time',
    A5: 'max_flow',
    A6: 'microleak',
    A7: 'external_sensor',
    A8: 'flow_sensor',
    A9: 'pressure_sensor',
    AA: 'temperature_sensor',
    AB: 'conductivity_sensor',
    AC: 'hardness_high',
    AD: 'conductivity_sensor',
    AE: 'valve_stuck',
    AF: 'pressure_sensor',
  },
};
// The alarms that are a leak (the leak sensor feature, the leak_detected trigger).
const LEAK_ALARMS = new Set([
  'leak_volume',
  'leak_time',
  'max_flow',
  'microleak',
  'external_sensor',
  'leak_volume_no_shutoff',
  'leak_time_no_shutoff',
]);
// Warning codes (getWRN) of the /trio devices -> key (texts `warning_<key>`).
const WARNINGS = {
  '01': 'power_outage',
  '03': 'temperature_low',
  '04': 'temperature_high',
  '07': 'leak',
  '08': 'battery_low',
  '0A': 'leak_volume',
  '0B': 'leak_time',
  12: 'battery_weak',
  13: 'no_battery',
  14: 'pressure_high',
  '1A': 'time_lost',
  A6: 'microleak',
};
const BATTERY_ALARMS = new Set(['battery_low']);
const BATTERY_WARNINGS = new Set(['battery_low', 'battery_weak', 'no_battery']);

// Model names: by the start of the serial number on /trio, by the firmware elsewhere.
const TRIO_MODELS = [
  ['100', 'Trio LS Connect'],
  ['112', 'SafeTech Plus Connect'],
  ['113', 'Trio DFR/LS Connect'],
  ['123', 'SafeTech Connect'],
  ['500', 'CONEL CLEAR PRO'],
  ['501', 'Sanibel Leak Protection A25'],
  ['502', 'DITECH Leak Protection'],
  ['503', 'TAKE Leak Protection'],
  ['504', 'concept 300'],
  ['505', 'Optima T2'],
  ['506', 'SafeTech Lock / TRIO Lock Connect'],
];

/**
 * @description A code (alarm, warning) in upper case, null for "no code".
 * @param {unknown} value - "ff", "A3", 255, null.
 * @returns {string|null} The code.
 */
function activeCode(value) {
  if (value === null || value === undefined) return null;
  const code = String(value).trim().toUpperCase();
  return NO_CODE.has(code) || code.startsWith('ERROR') ? null : code;
}

/**
 * @description A number out of a value of the device: 4101, "4900 mbar", "Vol[L]1885",
 * "9,36", "0mL". An error text ("ERR 65535", "ERROR: ADM"), "" or null is null.
 * @param {unknown} value - The raw value.
 * @returns {number|null} The number.
 */
function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text || /^ERR/i.test(text)) return null;
  const withoutPrefix = text.replace(/^[A-Za-z]+\[[^\]]*\]/, '');
  const match = withoutPrefix.match(/^-?\d+(?:[.,]\d+)?/);
  return match ? Number(match[0].replace(',', '.')) : null;
}

/**
 * @description A flag of the device: true, "true", 1, "1".
 * @param {unknown} value - The raw value.
 * @returns {boolean|null} The flag, null when absent.
 */
function flagOf(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  const number = Number(text);
  return Number.isFinite(number) ? number !== 0 : null;
}

/**
 * @description The valve as getAB reports it: closed or not, and the format to answer in.
 * @param {unknown} value - false/true (newer), 1/2 or "1"/"2" (older: 1 open, 2 closed).
 * @returns {{ closed: boolean|null, format: string|null }} `format`: `bool` or `number`.
 */
function valveOf(value) {
  if (typeof value === 'boolean') return { closed: value, format: 'bool' };
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (text === 'true' || text === 'false') return { closed: text === 'true', format: 'bool' };
  if (text === '1' || text === '2') return { closed: text === '2', format: 'number' };
  return { closed: null, format: null };
}

/**
 * @description A voltage: 619 (1/100 V), "9,36", "6,11 4,38 3,90" (the first one), "ADC:950 6,16V".
 * @param {unknown} value - The raw value.
 * @returns {number|null} Volts.
 */
function voltsOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value / 100 : null;
  const text = String(value ?? '').trim();
  if (!text) return null;
  const token = text.includes('ADC:')
    ? text
        .split(/\s+/)
        .find((part) => /v$/i.test(part))
        ?.slice(0, -1)
    : text.split(/\s+/)[0];
  if (!token) return null;
  if (token.includes(',') || token.includes('.')) {
    const volts = Number(token.replace(',', '.'));
    return Number.isFinite(volts) ? volts : null;
  }
  const hundredths = Number(token);
  return /^\d+$/.test(token) && Number.isFinite(hundredths) ? hundredths / 100 : null;
}

/**
 * @description The family of a device, for its alarm codes.
 * @param {string} path - The path it answers on.
 * @param {string} serial - Its serial number.
 * @returns {string} `safetech` or `common`.
 */
function familyOf(path, serial) {
  if (path !== '/trio') return 'safetech';
  return /^123/.test(serial) ? 'safetech' : 'common';
}

/**
 * @description The name of a model.
 * @param {string} path - The path it answers on.
 * @param {string} serial - Its serial number.
 * @param {string} firmware - getVER.
 * @returns {string} "SafeTech V4 Connect", "Trio DFR/LS Connect".
 */
function modelOf(path, serial, firmware) {
  if (path === '/pontos-base') return 'Hansgrohe Pontos Base';
  if (path === '/safe-tec') {
    const version = String(firmware).match(/Safe-?Tech\s*V(\d)/i);
    if (version) return `SafeTech V${version[1]} Connect`;
    return /^42/.test(serial) ? 'RWC MultiSafe' : 'SafeTech Connect';
  }
  const found = TRIO_MODELS.find(([prefix]) => serial.startsWith(prefix));
  return found ? found[1] : 'SYR Connect';
}

/**
 * @description The serial number of a device, as an id: lower case, letters and digits.
 * @param {unknown} value - getSRN.
 * @returns {string|null} The id, null when there is none.
 */
function serialId(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-z]/g, '');
  return text && text.length <= 32 ? text : null;
}

/**
 * @description The MAC address of the active connection (Ethernet first, then Wi-Fi).
 * @param {object} raw - The /get/all answer.
 * @returns {string|null} The MAC address.
 */
function macOf(raw) {
  for (const key of ['getMAC', 'getMAC2', 'getMAC1']) {
    const value = String(raw[key] ?? '').trim();
    if (/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(value)) return value.toLowerCase();
  }
  return null;
}

/**
 * @description The leak protection profiles of a device: the active ones with their names.
 * @param {object} raw - The /get/all answer.
 * @returns {Array<{ number: number, name: string }>} The profiles.
 */
function profilesOf(raw) {
  const count = numberOf(raw.getPRN);
  const profiles = [];
  for (const number of PROFILE_NUMBERS) {
    const active = flagOf(raw[`getPA${number}`]);
    const name = String(raw[`getPN${number}`] ?? '').trim();
    // Without getPAx (Pontos Base), the first getPRN profiles are the active ones.
    const listed = active ?? (Number.isFinite(count) ? number <= count : Boolean(name));
    if (listed) profiles.push({ number, name: name.slice(0, 40) || String(number) });
  }
  return profiles;
}

/**
 * @description The values of a device in one shape, from its /get/all answer.
 * @param {object} raw - The answer.
 * @param {string} path - The path it answered on.
 * @returns {object} The snapshot (see the fields below), `id` null when unusable.
 */
function parseStatus(raw, path) {
  const id = serialId(raw.getSRN);
  const serial = String(raw.getSRN ?? '').trim();
  const firmware = String(raw.getVER ?? '').trim();
  const family = familyOf(path, serial);
  const valve = valveOf(raw.getAB);
  const motor = numberOf(raw.getVLV);
  const motorState = VALVE_STATES[motor] ?? null;
  // The motor state is the truth while it moves; getAB says where it is going.
  const closed =
    motorState === 'closed' || motorState === 'closing'
      ? true
      : motorState === 'open' || motorState === 'opening'
        ? false
        : valve.closed;
  const pressureMbar = numberOf(raw.getBAR);
  const temperatureTenths = numberOf(raw.getCEL);
  // The leak protection modules without a sensor report 0 for both.
  const noSensors = /^MuCo/i.test(firmware) && pressureMbar === 0 && temperatureTenths === 0;
  const alarmCode = activeCode(raw.getALA);
  const alarm = alarmCode ? (ALARMS[family][alarmCode] ?? 'other') : null;
  const warningCode = path === '/trio' ? activeCode(raw.getWRN) : null;
  const warning = warningCode ? (WARNINGS[warningCode] ?? 'other') : null;
  const batteryPercent = (() => {
    const direct = numberOf(raw.getBAP);
    if (Number.isFinite(direct) && direct >= 0 && direct <= 100) return Math.round(direct);
    const volts = voltsOf(raw.getBAT);
    const full = voltsOf(raw.getBMA);
    const empty = voltsOf(raw.getBMI);
    if (!(volts > 0) || !Number.isFinite(full) || !Number.isFinite(empty) || empty >= full) {
      return null;
    }
    return Math.round(Math.min(1, Math.max(0, (volts - empty) / (full - empty))) * 100);
  })();
  const flowLh = numberOf(raw.getFLO);
  const currentMl = numberOf(raw.getAVO);
  const profile = numberOf(raw.getPRF);
  const typ = numberOf(raw.getTYP);
  return {
    id,
    serial,
    path,
    family,
    firmware: firmware.slice(0, 60),
    model: modelOf(path, serial, firmware),
    mac: macOf(raw),
    typ: Number.isFinite(typ) ? typ : null,
    valveFormat: valve.format,
    closed,
    motorState,
    flowLh: Number.isFinite(flowLh) && flowLh >= 0 ? flowLh : null,
    pressureBar: !noSensors && Number.isFinite(pressureMbar) ? pressureMbar / 1000 : null,
    temperatureC: !noSensors && Number.isFinite(temperatureTenths) ? temperatureTenths / 10 : null,
    totalL: numberOf(raw.getVOL),
    lastL: numberOf(raw.getLTV),
    currentL: Number.isFinite(currentMl) ? currentMl / 1000 : null,
    batteryV: voltsOf(raw.getBAT),
    batteryPercent,
    mainsV: voltsOf(raw.getNET),
    conductivity: numberOf(raw.getCND),
    wifiPercent: numberOf(raw.getWFR),
    alarmCode,
    alarm,
    leak: alarm ? LEAK_ALARMS.has(alarm) : false,
    warningCode,
    warning,
    batteryLow: BATTERY_ALARMS.has(alarm) || BATTERY_WARNINGS.has(warning),
    profile: Number.isFinite(profile) ? profile : null,
    profiles: profilesOf(raw),
    microleakTest: String(raw.getDSV ?? '').trim() === '1',
  };
}

/**
 * @description Whether an answer is the status of a SYR device.
 * @param {object} raw - The answer.
 * @returns {boolean} True when it has a serial number and a SYR value.
 */
function isStatus(raw) {
  return (
    Boolean(serialId(raw?.getSRN)) &&
    ['getVER', 'getVLV', 'getAB', 'getVOL', 'getALA'].some((key) => key in raw)
  );
}

/**
 * @description Read the status of a device on a path, with the expert mode when needed.
 * @param {object} client - The client of its address.
 * @param {string} path - `/trio`, `/safe-tec` or `/pontos-base`.
 * @param {object} session - Per address, kept by the caller: `{ adm: boolean|null, admAt: number }`.
 * @param {number} now - Now (ms).
 * @returns {Promise<object>} The raw /get/all answer.
 */
async function readStatus(client, path, session, now) {
  if (
    ADM_PATHS.includes(path) &&
    session.adm !== false &&
    now - (session.admAt ?? 0) > ADM_EVERY_MS
  ) {
    try {
      await client.getJson(`${path}/set/ADM/(2)f`);
      session.adm = true;
    } catch (err) {
      if (err.kind === 'http' && err.status === 404) session.adm = false;
      else if (err.kind === 'unreachable') throw err;
    }
    session.admAt = now;
  }
  const raw = await client.getJson(`${path}/get/all`);
  if (!isStatus(raw)) {
    throw new SyrError('invalid', `${client.address}${path}: not a SYR status`);
  }
  return raw;
}

/**
 * @description Check the answer to a command: `{"setABtrue": "OK"}`.
 * @param {object} answer - The answer.
 * @param {string} command - "ab", "prf".
 * @param {string} address - For the messages.
 */
function checkAnswer(answer, command, address) {
  const entry = Object.entries(answer).find(([key]) =>
    key.toLowerCase().startsWith(`set${command}`.toLowerCase()),
  );
  if (!entry) return;
  const status = String(entry[1]).trim().toUpperCase();
  if (status === 'OK' || status === 'FACTORY') return;
  if (status === 'MIMA' || status.endsWith('NSC') || status.endsWith('ADM')) {
    throw new SyrError('refused', `${address}: ${command} refused (${status})`, {
      code: status.replace(/^ERROR:\s*/, ''),
    });
  }
}

/**
 * @description Send a set command.
 * @param {object} client - The client.
 * @param {string} path - The path of the device.
 * @param {string} command - The command, lower case ("ab").
 * @param {string|number} value - The value, sent as it is.
 * @returns {Promise<void>}
 */
async function sendSet(client, path, command, value) {
  let answer;
  try {
    answer = await client.getJson(`${path}/set/${command}/${value}`);
  } catch (err) {
    // The Trio answers an unknown command with 404, not with NSC.
    if (err.kind === 'http' && err.status === 404) {
      throw new SyrError('refused', `${client.address}: ${command} not supported`, { code: 'NSC' });
    }
    throw err;
  }
  checkAnswer(answer, command, client.address);
}

/**
 * @description Open or close the valve, in the format the device reports getAB in.
 * @param {object} client - The client.
 * @param {object} device - The snapshot (`path`, `valveFormat`).
 * @param {boolean} close - Close (true) or open.
 * @returns {Promise<void>}
 */
async function setValve(client, device, close) {
  if (!device.valveFormat) {
    throw new SyrError('refused', `${client.address}: no valve`, { code: 'NSC' });
  }
  const value = device.valveFormat === 'bool' ? String(close) : close ? 2 : 1;
  return sendSet(client, device.path, 'ab', value);
}

/**
 * @description Select a leak protection profile.
 * @param {object} client - The client.
 * @param {object} device - The snapshot.
 * @param {number} number - 1 to 8.
 * @returns {Promise<void>}
 */
function setProfile(client, device, number) {
  return sendSet(client, device.path, 'prf', number);
}

/**
 * @description Start the microleak test (the valve closes about 4 minutes).
 * @param {object} client - The client.
 * @param {object} device - The snapshot (`typ`).
 * @returns {Promise<void>}
 */
function startMicroleakTest(client, device) {
  const value = Number.isFinite(device.typ) && device.typ < 100 ? 1 : 'true';
  return sendSet(client, device.path, 'dex', value);
}

/**
 * @description Clear the current alarm.
 * @param {object} client - The client.
 * @param {object} device - The snapshot (`path`, `family`).
 * @returns {Promise<void>}
 */
async function clearAlarm(client, device) {
  if (device.family === 'safetech') {
    try {
      await client.getJson(`${device.path}/clr/ala`);
    } catch (err) {
      if (err.kind === 'http' && err.status === 404) {
        throw new SyrError('refused', `${client.address}: alarm reset not supported`, {
          code: 'NSC',
        });
      }
      throw err;
    }
    return;
  }
  await sendSet(client, device.path, 'ala', 255);
}

export {
  PATHS,
  ADM_PATHS,
  ADM_EVERY_MS,
  VALVE,
  ALARMS,
  WARNINGS,
  LEAK_ALARMS,
  activeCode,
  numberOf,
  flagOf,
  valveOf,
  voltsOf,
  familyOf,
  modelOf,
  serialId,
  profilesOf,
  parseStatus,
  isStatus,
  readStatus,
  setValve,
  setProfile,
  startMicroleakTest,
  clearAlarm,
};
