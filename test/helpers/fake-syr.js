// -----------------------------------------------------------------------------
// Fake SYR devices for the tests: the answers of the local JSON API in the
// shapes seen on real devices (documented by alexhass/syr_connect and
// ahornung/syr-safetech-connect-api), with made-up values.
//
//   trio        /trio: native JSON types (getAB false, getBAR 4101 in mbar,
//               getBAT 619 in 1/100 V), getALA "ff", getWRN, /set/ala/255;
//               an unknown command is a 404 (Trio firmware)
//   safetec     /safe-tec: strings with units ("4900 mbar", "Vol[L]1885",
//               "9,36", "0mL"), getAB "1"/"2", every value only after
//               /set/ADM/(2)f ("ERROR: ADM" before), /clr/ala
//   pontos      /pontos-base: like safetec, without getAB
//
// Nothing starts on import (node --test also runs this folder).
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * @description A fake device.
 * @param {string} kind - `trio`, `safetec` or `pontos`.
 * @param {object} [overrides] - Values to change.
 * @returns {object} The state.
 */
function syrState(kind = 'trio', overrides = {}) {
  const base = {
    kind,
    serial: kind === 'trio' ? '112ABC00042' : kind === 'pontos' ? '000000777' : '987650001',
    closed: false,
    motor: 20,
    flowLh: 0,
    pressureMbar: 4100,
    temperatureTenths: 118,
    totalL: 7094,
    lastL: 3,
    currentMl: 0,
    alarm: 'ff',
    warning: 'ff',
    profile: 1,
    profiles: ['Anwesend', 'Abwesend', 'Urlaub'],
    batteryHundredths: 619,
    adm: false,
    microleak: false,
    reachable: true,
    requests: [],
  };
  return { ...base, ...overrides };
}

const PATHS = { trio: '/trio', safetec: '/safe-tec', pontos: '/pontos-base' };

/**
 * @description The /get/all answer of a device.
 * @param {object} state - The state.
 * @returns {object} The JSON object.
 */
function getAll(state) {
  if (state.kind === 'trio') {
    const answer = {
      getSRN: state.serial,
      getVER: 'syr001-A-B-000-176',
      getAB: state.closed,
      getVLV: state.motor,
      getALA: state.alarm,
      getALM: 'ff,04',
      getWRN: state.warning,
      getNOT: 'ff',
      getBAR: state.pressureMbar,
      getCEL: state.temperatureTenths,
      getFLO: state.flowLh,
      getVOL: state.totalL,
      getLTV: state.lastL,
      getAVO: state.currentMl,
      getBAT: state.batteryHundredths,
      getBMA: 585,
      getBMI: 515,
      getNET: 515,
      getPRF: state.profile,
      getPRN: state.profiles.length,
      getMAC1: '68:5e:1c:12:34:56',
      getMAC2: 'c4:98:94:12:34:57',
      getWFR: 80,
      getDSV: state.microleak ? 1 : 0,
      getCND: 203,
    };
    for (let number = 1; number <= 8; number += 1) {
      answer[`getPA${number}`] = number <= state.profiles.length;
      answer[`getPN${number}`] = state.profiles[number - 1] ?? '';
    }
    return answer;
  }
  if (!state.adm) {
    return {
      getSRN: state.serial,
      getVER: state.kind === 'pontos' ? 'PontosBase V1.31' : 'Safe-Tech V4.08',
      getVLV: String(state.motor),
      getALA: 'ERROR: ADM',
      getBAR: 'ERROR: ADM',
      getVOL: 'ERROR: ADM',
    };
  }
  const answer = {
    getSRN: state.serial,
    getVER: state.kind === 'pontos' ? 'PontosBase V1.31' : 'Safe-Tech V4.08',
    getTYP: '140',
    getVLV: String(state.motor),
    getALA: state.alarm.toUpperCase(),
    getALM: 'Alarms:->AF AF A9 A9',
    getBAR: `${state.pressureMbar} mbar`,
    getCEL: String(state.temperatureTenths),
    getFLO: String(state.flowLh),
    getVOL: `Vol[L]${state.totalL}`,
    getLTV: String(state.lastL),
    getAVO: `${state.currentMl}mL`,
    getBAT: '9,36',
    getNET: '11,86',
    getPRF: String(state.profile),
    getPRN: String(state.profiles.length),
    getMAC: 'BA:DF:00:12:34:56',
    getWFR: '32',
    getDSV: state.microleak ? '1' : '0',
  };
  if (state.kind === 'safetec') answer.getAB = state.closed ? '2' : '1';
  for (let number = 1; number <= 8; number += 1) {
    answer[`getPN${number}`] = state.profiles[number - 1] ?? '';
    if (state.kind === 'safetec')
      answer[`getPA${number}`] = number <= state.profiles.length ? '1' : '0';
  }
  return answer;
}

/**
 * @description The answer of a device to a request.
 * @param {object} state - The state (changed by the commands).
 * @param {string} path - The path.
 * @returns {{ status: number, body: string }} The answer.
 */
function syrAnswer(state, path) {
  state.requests.push(path);
  const base = PATHS[state.kind];
  const json = (value) => ({ status: 200, body: JSON.stringify(value) });
  if (!path.startsWith(`${base}/`)) return { status: 404, body: 'Not Found' };
  const rest = path.slice(base.length);
  if (rest === '/set/ADM/(2)f') {
    if (state.kind === 'trio') return { status: 404, body: '' };
    state.adm = true;
    return json({ 'setADM(2)f': 'OK' });
  }
  if (rest === '/get/all') return json(getAll(state));
  if (rest === '/clr/ala') {
    if (state.kind === 'trio') return { status: 404, body: '' };
    state.alarm = 'ff';
    return json({ clrALA: 'OK' });
  }
  const set = rest.match(/^\/set\/([a-z]+)\/(.+)$/);
  if (!set) return { status: 404, body: '' };
  const [, command, value] = set;
  const ok = json({ [`set${command.toUpperCase()}${value}`]: 'OK' });
  switch (command) {
    case 'ab': {
      const close = value === 'true' || value === '2';
      if (state.kind === 'trio' && !['true', 'false'].includes(value)) {
        return json({ [`setAB${value}`]: 'MIMA' });
      }
      state.closed = close;
      state.motor = close ? 10 : 20;
      return ok;
    }
    case 'prf': {
      const number = Number(value);
      if (!(number >= 1 && number <= state.profiles.length)) {
        return json({ [`setPRF${value}`]: 'MIMA' });
      }
      state.profile = number;
      return ok;
    }
    case 'dex':
      state.microleak = true;
      return ok;
    case 'ala':
      if (state.kind !== 'trio') return json({ [`setALA${value}`]: 'NSC' });
      state.alarm = 'ff';
      return ok;
    default:
      return state.kind === 'trio' ? { status: 404, body: '' } : json({ [`set${command}`]: 'NSC' });
  }
}

/**
 * @description A fake network: addresses → devices, `null` for a web server
 * that is no SYR device (404 everywhere).
 * @param {object} devices - `{ "192.168.1.40": state }`.
 * @returns {{ request: Function, calls: object[] }} The transport for createSyrClient, the calls.
 */
function fakeNetwork(devices) {
  const calls = [];
  const request = async ({ host, port, path }) => {
    calls.push({ address: host, path });
    if (devices[host] === null) return { status: 404, body: '<html>a box</html>' };
    const state = devices[host];
    if (!state || port !== 5333 || !state.reachable) {
      throw new Error('connect EHOSTUNREACH');
    }
    if (state.raw !== undefined) return { status: 200, body: state.raw };
    return syrAnswer(state, path);
  };
  return { request, calls };
}

/**
 * @description A fresh writable folder (the /data of a test).
 * @returns {string} The folder.
 */
const dataDir = () => mkdtempSync(join(tmpdir(), 'syr-'));

/**
 * @description A logger that keeps the lines.
 * @returns {object} The logger, with `lines`.
 */
function recordingLogger() {
  const lines = [];
  const keep =
    (level) =>
    (...args) =>
      lines.push([
        level,
        args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '),
      ]);
  return {
    lines,
    debug: keep('debug'),
    info: keep('info'),
    warn: keep('warn'),
    error: keep('error'),
  };
}

export { PATHS, syrState, getAll, syrAnswer, fakeNetwork, dataDir, recordingLogger };
