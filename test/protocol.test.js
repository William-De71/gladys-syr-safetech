// The local JSON API of the SYR devices: the HTTP client, the three shapes of
// answers, the commands. No test touches the network (fake transport).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyrClient, splitAddress, SyrError } from '../src/syr-api.js';
import {
  parseStatus,
  readStatus,
  setValve,
  setProfile,
  startMicroleakTest,
  clearAlarm,
  numberOf,
  voltsOf,
  valveOf,
  activeCode,
  profilesOf,
  modelOf,
} from '../src/syr.js';
import { syrState, getAll, fakeNetwork } from './helpers/fake-syr.js';

const clientFor = (state, address = 'syr') => {
  const network = fakeNetwork({ [address]: state });
  return {
    client: createSyrClient({ address, request: network.request, sleep: async () => {} }),
    network,
  };
};

test('addresses: port 5333 by default, a port, IPv6 in brackets', () => {
  assert.deepEqual(splitAddress('192.168.1.40'), { host: '192.168.1.40', port: 5333 });
  assert.deepEqual(splitAddress('safetech.local:8080'), { host: 'safetech.local', port: 8080 });
  assert.deepEqual(splitAddress('[fe80::1]'), { host: 'fe80::1', port: 5333 });
});

test('values: units, comma decimals, error texts, flags', () => {
  assert.equal(numberOf(4101), 4101);
  assert.equal(numberOf('4900 mbar'), 4900);
  assert.equal(numberOf('Vol[L]1885'), 1885);
  assert.equal(numberOf('0mL'), 0);
  assert.equal(numberOf('9,36'), 9.36);
  assert.equal(numberOf('ERR 65535'), null);
  assert.equal(numberOf('ERROR: ADM'), null);
  assert.equal(numberOf(''), null);
  assert.equal(numberOf(null), null);
  assert.equal(voltsOf(619), 6.19);
  assert.equal(voltsOf('9,36'), 9.36);
  assert.equal(voltsOf('6,11 4,38 3,90'), 6.11);
  assert.equal(voltsOf('ADC:950 6,16V'), 6.16);
  assert.equal(voltsOf('363'), 3.63);
  assert.deepEqual(valveOf(false), { closed: false, format: 'bool' });
  assert.deepEqual(valveOf('true'), { closed: true, format: 'bool' });
  assert.deepEqual(valveOf('1'), { closed: false, format: 'number' });
  assert.deepEqual(valveOf(2), { closed: true, format: 'number' });
  assert.deepEqual(valveOf(undefined), { closed: null, format: null });
  assert.equal(activeCode('ff'), null);
  assert.equal(activeCode('FF'), null);
  assert.equal(activeCode(255), null);
  assert.equal(activeCode('ERROR: ADM'), null);
  assert.equal(activeCode('a3'), 'A3');
});

test('/trio: native types, the common alarm table, warnings, battery from BMA/BMI', () => {
  const values = parseStatus(getAll(syrState('trio', { alarm: 'a3', warning: '08' })), '/trio');
  assert.equal(values.id, '112abc00042');
  assert.equal(values.model, 'SafeTech Plus Connect');
  assert.equal(values.family, 'common');
  assert.equal(values.closed, false);
  assert.equal(values.motorState, 'open');
  assert.equal(values.valveFormat, 'bool');
  assert.equal(values.pressureBar, 4.1);
  assert.equal(values.temperatureC, 11.8);
  assert.equal(values.totalL, 7094);
  assert.equal(values.currentL, 0);
  assert.equal(values.alarm, 'leak_volume');
  assert.equal(values.leak, true);
  assert.equal(values.warning, 'battery_low');
  assert.equal(values.batteryLow, true);
  assert.equal(values.batteryPercent, 100, '6.19 V above the 5.85 V of 100 %');
  assert.equal(values.mac, 'c4:98:94:12:34:57');
  assert.deepEqual(
    values.profiles.map((profile) => profile.name),
    ['Anwesend', 'Abwesend', 'Urlaub'],
  );
});

test('/trio: the leak protection module without sensors reports no pressure nor temperature', () => {
  const raw = { ...getAll(syrState('trio')), getVER: 'MuCo V.2.24', getBAR: 0, getCEL: 0 };
  const values = parseStatus(raw, '/trio');
  assert.equal(values.pressureBar, null);
  assert.equal(values.temperatureC, null);
  const trio = parseStatus({ ...getAll(syrState('trio')), getBAR: null, getCEL: null }, '/trio');
  assert.equal(trio.pressureBar, null, 'a Trio DFR/LS has no pressure sensor');
});

test('/safe-tec: strings with units, the SafeTech alarm table, the valve as 1/2', () => {
  const state = syrState('safetec', { adm: true, closed: true, motor: 10, alarm: 'AD' });
  const values = parseStatus(getAll(state), '/safe-tec');
  assert.equal(values.model, 'SafeTech V4 Connect');
  assert.equal(values.family, 'safetech');
  assert.equal(values.closed, true);
  assert.equal(values.valveFormat, 'number');
  assert.equal(values.pressureBar, 4.1);
  assert.equal(values.totalL, 7094);
  assert.equal(values.batteryV, 9.36);
  assert.equal(values.batteryPercent, null, 'no BMA/BMI on a SafeTech');
  assert.equal(values.alarm, 'battery_low');
  assert.equal(values.leak, false);
  assert.equal(values.batteryLow, true);
  assert.equal(values.mac, 'ba:df:00:12:34:56');
});

test('/pontos-base: no getAB (no valve control), profiles from getPRN', () => {
  const values = parseStatus(getAll(syrState('pontos', { adm: true })), '/pontos-base');
  assert.equal(values.model, 'Hansgrohe Pontos Base');
  assert.equal(values.valveFormat, null);
  assert.equal(values.closed, false, 'the motor state still tells');
  assert.equal(profilesOf(getAll(syrState('pontos', { adm: true }))).length, 3);
});

test('models: by firmware, by serial number', () => {
  assert.equal(modelOf('/safe-tec', '987650001', 'Safe-Tech V3.56'), 'SafeTech V3 Connect');
  assert.equal(modelOf('/safe-tec', '420001', ''), 'RWC MultiSafe');
  assert.equal(modelOf('/trio', '113AAA12345', 'syr001'), 'Trio DFR/LS Connect');
  assert.equal(modelOf('/trio', '506AAA12345', 'MuCo V.2.24'), 'SafeTech Lock / TRIO Lock Connect');
  assert.equal(modelOf('/trio', '999', ''), 'SYR Connect');
});

test('the expert mode: sent before /get/all on /safe-tec, every 30 min; never on /trio', async () => {
  const state = syrState('safetec');
  const { client, network } = clientFor(state);
  const session = { adm: null, admAt: 0 };
  const raw = await readStatus(client, '/safe-tec', session, 1000000000);
  assert.equal(raw.getALA, 'FF');
  assert.equal(session.adm, true);
  await readStatus(client, '/safe-tec', session, 1000000000 + 60000);
  await readStatus(client, '/safe-tec', session, 1000000000 + 31 * 60000);
  assert.deepEqual(
    network.calls.map((call) => call.path),
    [
      '/safe-tec/set/ADM/(2)f',
      '/safe-tec/get/all',
      '/safe-tec/get/all',
      '/safe-tec/set/ADM/(2)f',
      '/safe-tec/get/all',
    ],
  );
  const trio = clientFor(syrState('trio'));
  await readStatus(trio.client, '/trio', { adm: null, admAt: 0 }, 1000000000);
  assert.deepEqual(
    trio.network.calls.map((call) => call.path),
    ['/trio/get/all'],
  );
});

test('a wrong path is not a SYR status; a non JSON answer is invalid; no answer is unreachable', async () => {
  const { client } = clientFor(syrState('trio'));
  await assert.rejects(readStatus(client, '/safe-tec', { adm: false }, 0), {
    kind: 'http',
    status: 404,
  });
  const html = clientFor({ ...syrState('trio'), raw: '<html></html>' });
  await assert.rejects(html.client.getJson('/trio/get/all'), { kind: 'invalid' });
  const other = clientFor({ ...syrState('trio'), raw: '{"hello":1}' });
  await assert.rejects(readStatus(other.client, '/trio', {}, 0), { kind: 'invalid' });
  const down = clientFor({ ...syrState('trio'), reachable: false });
  await assert.rejects(down.client.getJson('/trio/get/all'), (err) => {
    assert.ok(err instanceof SyrError);
    assert.equal(err.kind, 'unreachable');
    return true;
  });
});

test('commands: the valve in the format of the device, lower case paths', async () => {
  const trio = syrState('trio');
  const a = clientFor(trio);
  await setValve(a.client, { path: '/trio', valveFormat: 'bool' }, true);
  assert.equal(trio.closed, true);
  await setValve(a.client, { path: '/trio', valveFormat: 'bool' }, false);
  assert.equal(trio.closed, false);
  const old = syrState('safetec', { adm: true });
  const b = clientFor(old);
  await setValve(b.client, { path: '/safe-tec', valveFormat: 'number' }, true);
  assert.equal(old.closed, true);
  assert.deepEqual(
    [...a.network.calls, ...b.network.calls].map((call) => call.path),
    ['/trio/set/ab/true', '/trio/set/ab/false', '/safe-tec/set/ab/2'],
  );
  await assert.rejects(
    () => setValve(b.client, { path: '/pontos-base', valveFormat: null }, true),
    {
      kind: 'refused',
    },
  );
});

test('commands: profile, microleak test, alarm reset per family; refusals', async () => {
  const trio = syrState('trio', { alarm: 'a6' });
  const { client, network } = clientFor(trio);
  await setProfile(client, { path: '/trio' }, 2);
  assert.equal(trio.profile, 2);
  await assert.rejects(setProfile(client, { path: '/trio' }, 7), { kind: 'refused', code: 'MIMA' });
  await startMicroleakTest(client, { path: '/trio', typ: null });
  assert.equal(trio.microleak, true);
  await clearAlarm(client, { path: '/trio', family: 'common' });
  assert.equal(trio.alarm, 'ff');
  assert.deepEqual(
    network.calls.map((call) => call.path),
    ['/trio/set/prf/2', '/trio/set/prf/7', '/trio/set/dex/true', '/trio/set/ala/255'],
  );
  const old = syrState('safetec', { adm: true, alarm: 'A3' });
  const b = clientFor(old);
  await clearAlarm(b.client, { path: '/safe-tec', family: 'safetech' });
  await startMicroleakTest(b.client, { path: '/safe-tec', typ: 80 });
  assert.equal(old.alarm, 'ff');
  assert.deepEqual(
    b.network.calls.map((call) => call.path),
    ['/safe-tec/clr/ala', '/safe-tec/set/dex/1'],
  );
  // The Trio answers an unknown command with 404.
  await assert.rejects(clearAlarm(client, { path: '/trio', family: 'safetech' }), {
    kind: 'refused',
  });
});

test('one request at a time per device, in order, a failure does not block the queue', async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const request = async ({ path }) => {
    order.push(`start ${path}`);
    if (path === '/a') await gate;
    order.push(`end ${path}`);
    if (path === '/b') throw new Error('boom');
    return { status: 200, body: '{}' };
  };
  const client = createSyrClient({ address: 'x', request, sleep: async () => {} });
  const first = client.getJson('/a');
  const second = client.getJson('/b').catch((err) => err.kind);
  const third = client.getJson('/c');
  release();
  await first;
  assert.equal(await second, 'unreachable');
  await third;
  assert.deepEqual(order, ['start /a', 'end /a', 'start /b', 'end /b', 'start /c', 'end /c']);
});
