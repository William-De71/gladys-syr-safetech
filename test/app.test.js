// The whole integration against the fake Gladys of the SDK
// (`@gladysassistant/integration-sdk/testing`), which checks the discovered
// devices, the states and the scene events like the host API does, and fake
// SYR devices (test/helpers/fake-syr.js) on a fake clock.
// No test touches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';

import { createApp, ACTIONS } from '../src/app.js';
import { WIDGETS, WIDGET_ACTIONS } from '../src/widgets.js';
import { TRIGGERS, SCENE_ACTIONS, OUTPUTS } from '../src/events.js';
import { FILE } from '../src/store.js';
import { LANGUAGES } from '../src/i18n.js';
import { fakeNetwork, syrState, dataDir, recordingLogger } from './helpers/fake-syr.js';

const NOW = Date.parse('2026-11-22T10:00:00Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const TRIO = '192.168.1.40';
const OLD = '192.168.1.41';
const CONFIG = { hosts: `${TRIO}, ${OLD}`, interval: '30', language: 'en' };
const PREFIX = 'ext:test-integration';
const TRIO_ID = '112abc00042';
const OLD_ID = '987650001';
const id = (serial, feature) => `${PREFIX}:syr:${serial}${feature ? `:${feature}` : ''}`;

/**
 * @description The integration, connected to a fake Gladys and fake devices.
 * @param {object} t - The test context.
 * @param {object} [options] - `{ config, dir, clock, devices }`.
 * @returns {Promise<object>} `{ gladys, app, network, clock, dir, logger, trio, old }`.
 */
async function startApp(
  t,
  { config = CONFIG, dir = dataDir(), clock = { now: NOW }, devices } = {},
) {
  const trio = syrState('trio');
  const old = syrState('safetec');
  const network = fakeNetwork(devices ?? { [TRIO]: trio, [OLD]: old });
  const logger = recordingLogger();
  const gladys = createFakeGladys({ config });
  const app = createApp(gladys, {
    request: network.request,
    dataDir: dir,
    now: () => clock.now,
    sleep: async () => {},
    timeZone: 'Europe/Paris',
    timers: false,
    logger,
  });
  await gladys.connect();
  await app.whenReady();
  t.after(async () => {
    await gladys.fake.shutdown().catch(() => {});
  });
  return { gladys, app, network, clock, dir, logger, trio, old };
}

/**
 * @description Run the timer like the real one (every 30 s) for a while.
 * @param {object} env - `{ app, clock }`.
 * @param {number} ms - How long.
 * @param {number} [step] - The interval.
 */
async function run({ app, clock }, ms, step = 30 * SECOND) {
  const end = clock.now + ms;
  while (clock.now < end) {
    await app.tick();
    clock.now += step;
  }
}

/**
 * @description Create every offered device, like the user would.
 * @param {object} gladys - The fake Gladys.
 */
async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(structuredClone(device));
  }
}
const widget = async (gladys, key, options) =>
  (await gladys.fake.widgetGet(key, options)).data.content;
const events = (gladys, key) => gladys.fake.sceneEvents.filter((event) => event.key === key);
const lastState = (gladys, externalId) =>
  gladys.fake.states.filter((state) => state.device_feature_external_id === externalId).at(-1);
const deviceOf = (gladys, externalId) =>
  gladys.fake.discoveredDevices.find((device) => device.external_id === externalId);
const featureOf = (device, key) =>
  device.features.find((feature) => feature.external_id.endsWith(`:${key}`));

test('startup: each address recognised by its path, the devices offered', async (t) => {
  const env = await startApp(t);
  const { gladys, network } = env;
  assert.deepEqual(network.calls, [], 'no request before the timer');
  await run(env, 30 * SECOND);
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((device) => [device.name, device.external_id]),
    [
      ['SYR SafeTech Plus Connect 112ABC00042', id(TRIO_ID)],
      ['SYR SafeTech V4 Connect 987650001', id(OLD_ID)],
    ],
  );
  const oldCalls = () => network.calls.filter((call) => call.address === OLD).map((c) => c.path);
  // Tried on /trio first (404), then /safe-tec with the expert mode; then remembered.
  assert.deepEqual(oldCalls(), ['/trio/get/all', '/safe-tec/set/ADM/(2)f', '/safe-tec/get/all']);
  await run(env, 30 * SECOND);
  assert.equal(oldCalls().at(-1), '/safe-tec/get/all');
  assert.equal(oldCalls().length, 4);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(
    gladys.fake.connectionStatus.message.en,
    '2 device(s): SYR SafeTech Plus Connect 112ABC00042, SYR SafeTech V4 Connect 987650001.',
  );
  assert.deepEqual(gladys.fake.states, [], 'no state before the devices exist');
  assert.deepEqual(gladys.fake.sceneEvents, [], 'never at the first reading');
  const stored = JSON.parse(readFileSync(join(env.dir, FILE), 'utf8'));
  assert.deepEqual(stored.addresses, { [TRIO]: '/trio', [OLD]: '/safe-tec' });
});

test('states once created, only what changed', async (t) => {
  const env = await startApp(t);
  const { gladys, trio } = env;
  await run(env, 30 * SECOND);
  await createAll(gladys);
  assert.equal(lastState(gladys, id(TRIO_ID, 'valve')).state, 1);
  assert.equal(lastState(gladys, id(TRIO_ID, 'pressure')).state, 4.1);
  assert.equal(lastState(gladys, id(TRIO_ID, 'alarm')).text, 'No alarm');
  assert.equal(lastState(gladys, id(TRIO_ID, 'profile')).text, '1');
  assert.equal(lastState(gladys, id(OLD_ID, 'total_volume')).state, 7.094);
  const count = gladys.fake.states.length;
  await run(env, 30 * SECOND);
  assert.equal(gladys.fake.states.length, count, 'nothing changed');
  trio.flowLh = 600;
  await run(env, 30 * SECOND);
  assert.deepEqual(
    gladys.fake.states.slice(count).map((state) => [state.device_feature_external_id, state.state]),
    [[id(TRIO_ID, 'flow'), 0.6]],
  );
});

test('the water supply switch and the profile select drive the device', async (t) => {
  const env = await startApp(t);
  const { gladys, trio, old, network } = env;
  await run(env, 30 * SECOND);
  await createAll(gladys);
  const device = deviceOf(gladys, id(TRIO_ID));
  let ack = await gladys.fake.setValue(device, featureOf(device, 'valve'), 0);
  assert.equal(ack.success, true, ack.error);
  assert.equal(trio.closed, true);
  assert.ok(network.calls.some((call) => call.path === '/trio/set/ab/true'));
  assert.equal(lastState(gladys, id(TRIO_ID, 'valve')).state, 0, 'read back at once');
  ack = await gladys.fake.setValue(device, featureOf(device, 'valve'), 1);
  assert.equal(ack.success, true, ack.error);
  assert.equal(trio.closed, false);
  ack = await gladys.fake.setValue(device, featureOf(device, 'profile'), '2');
  assert.equal(ack.success, true, ack.error);
  assert.equal(trio.profile, 2);
  assert.equal(lastState(gladys, id(TRIO_ID, 'profile')).text, '2');
  ack = await gladys.fake.setValue(device, featureOf(device, 'profile'), '7');
  assert.equal(ack.success, false, 'not a profile of the device');
  ack = await gladys.fake.setValue(device, featureOf(device, 'pressure'), 3);
  assert.equal(ack.success, false, 'read only');
  const oldDevice = deviceOf(gladys, id(OLD_ID));
  await gladys.fake.setValue(oldDevice, featureOf(oldDevice, 'valve'), 0);
  assert.equal(old.closed, true);
  assert.ok(network.calls.some((call) => call.path === '/safe-tec/set/ab/2'));
  assert.deepEqual(gladys.fake.sceneEvents, [], 'commands fire nothing');
});

test('triggers: leak, alarm, cleared (not when Gladys clears it), warning', async (t) => {
  const env = await startApp(t);
  const { gladys, trio } = env;
  await run(env, 30 * SECOND);
  await createAll(gladys);
  trio.alarm = 'a3';
  trio.closed = true;
  trio.motor = 10;
  await run(env, 30 * SECOND);
  const [leak] = events(gladys, TRIGGERS.LEAK);
  assert.deepEqual(leak.data, {
    device: id(TRIO_ID),
    device_name: 'SYR SafeTech Plus Connect 112ABC00042',
    code: 'A3',
    alarm: 'Leak: volume limit reached',
    leak: true,
    valve_closed: true,
    message: 'Leak detected by SYR SafeTech Plus Connect 112ABC00042: Leak: volume limit reached.',
  });
  assert.equal(events(gladys, TRIGGERS.ALARM).length, 1);
  assert.equal(lastState(gladys, id(TRIO_ID, 'leak')).state, 1);
  await run(env, 2 * MINUTE);
  assert.equal(events(gladys, TRIGGERS.LEAK).length, 1, 'once per transition');
  // Cleared on the device: fires.
  trio.alarm = 'ff';
  await run(env, 30 * SECOND);
  assert.equal(events(gladys, TRIGGERS.ALARM_CLEARED).length, 1);
  // A fault, then cleared by a scene: no "cleared".
  trio.alarm = 'a9';
  await run(env, 30 * SECOND);
  assert.equal(events(gladys, TRIGGERS.ALARM).length, 2);
  assert.equal(events(gladys, TRIGGERS.LEAK).length, 1, 'a sensor fault is no leak');
  const ack = await gladys.fake.sceneAction(SCENE_ACTIONS.RESET_ALARM, { device: id(TRIO_ID) });
  assert.equal(ack.success, true, ack.error);
  assert.equal(ack.data.outputs.previous_alarm, 'Pressure sensor fault');
  await run(env, 2 * MINUTE);
  assert.equal(events(gladys, TRIGGERS.ALARM_CLEARED).length, 1, 'ours');
  trio.warning = '01';
  await run(env, 30 * SECOND);
  const [warning] = events(gladys, TRIGGERS.WARNING);
  assert.equal(warning.data.warning, 'Power cut');
  assert.equal(warning.data.code, '01');
});

test('triggers: unreachable after 3 readings and a minute, back online', async (t) => {
  const env = await startApp(t);
  const { gladys, trio } = env;
  await run(env, 30 * SECOND);
  trio.reachable = false;
  await run(env, 60 * SECOND);
  assert.deepEqual(events(gladys, TRIGGERS.UNREACHABLE), [], 'two readings only');
  await run(env, 60 * SECOND);
  const [down] = events(gladys, TRIGGERS.UNREACHABLE);
  assert.equal(down.data.failures, 3);
  assert.equal(down.data.address, TRIO);
  assert.match(gladys.fake.connectionStatus.message.en, /Not answering: SYR SafeTech Plus/);
  trio.reachable = true;
  await run(env, 30 * SECOND);
  const [back] = events(gladys, TRIGGERS.BACK_ONLINE);
  assert.equal(back.data.down_minutes, 2);
});

test('scene actions: profile, microleak test, consumption; only the declared outputs', async (t) => {
  const env = await startApp(t);
  const { gladys, trio, clock } = env;
  await run(env, 30 * SECOND);
  let ack = await gladys.fake.sceneAction(SCENE_ACTIONS.SET_PROFILE, {
    device: id(TRIO_ID),
    profile: 2,
  });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, {
    device_name: 'SYR SafeTech Plus Connect 112ABC00042',
    profile: 2,
    profile_name: 'Abwesend',
    summary: 'SYR SafeTech Plus Connect 112ABC00042: profile “Abwesend” selected.',
  });
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.SET_PROFILE, {
    device: id(TRIO_ID),
    profile: 8,
  });
  assert.equal(ack.success, false);
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.MICROLEAK_TEST, { device: id(TRIO_ID) });
  assert.equal(ack.success, true, ack.error);
  assert.equal(trio.microleak, true);
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.RESET_ALARM, { device: id(TRIO_ID) });
  assert.equal(
    ack.data.outputs.summary,
    'SYR SafeTech Plus Connect 112ABC00042: no alarm to clear.',
  );
  // A day of water: 7094 L at the first reading, 7300 the next morning, 7350 now.
  clock.now = Date.parse('2026-11-23T06:00:00Z');
  trio.totalL = 7300;
  await run(env, 30 * SECOND);
  clock.now = Date.parse('2026-11-23T12:00:00Z');
  trio.totalL = 7350;
  trio.flowLh = 480;
  await run(env, 30 * SECOND);
  ack = await gladys.fake.sceneAction(SCENE_ACTIONS.GET_CONSUMPTION, { device: id(TRIO_ID) });
  assert.deepEqual(ack.data.outputs, {
    device_name: 'SYR SafeTech Plus Connect 112ABC00042',
    today_liters: 50,
    yesterday_liters: 206,
    total_m3: 7.35,
    flow_lpm: 8,
    valve_open: true,
    summary: 'SYR SafeTech Plus Connect 112ABC00042: 50 L today, 206 L yesterday, meter 7.4 m³.',
  });
  for (const [key, outputs] of Object.entries(OUTPUTS)) {
    const fields =
      key === 'set_profile' ? { device: id(TRIO_ID), profile: 1 } : { device: id(OLD_ID) };
    const result = await gladys.fake.sceneAction(key, fields);
    assert.equal(result.success, true, `${key}: ${result.error}`);
    for (const output of Object.keys(result.data.outputs ?? {})) {
      assert.ok(outputs.includes(output), `${key}: ${output}`);
    }
  }
});

test('widgets: overview and consumption in every language, valid; the buttons act', async (t) => {
  const env = await startApp(t);
  const { gladys, trio, clock } = env;
  await run(env, 30 * SECOND);
  for (const language of LANGUAGES) {
    for (const key of Object.values(WIDGETS)) {
      for (const device of [id(TRIO_ID), id(OLD_ID)]) {
        const content = await widget(gladys, key, { language, settings: { device } });
        const result = validateWidgetContent(content);
        assert.deepEqual(result.errors ?? [], [], `${key} ${language}`);
        assert.ok(content.components.length <= 8, `${key} ${language}: budget`);
      }
    }
  }
  trio.alarm = 'a4';
  await run(env, 30 * SECOND);
  let content = await widget(gladys, WIDGETS.OVERVIEW, {
    language: 'fr',
    settings: { device: id(TRIO_ID) },
  });
  const buttons = content.components.filter((component) => component.type === 'button');
  assert.deepEqual(
    buttons.map((button) => [button.label, button.action.key, button.action.confirm ?? false]),
    [
      ['Couper l’eau', WIDGET_ACTIONS.CLOSE_VALVE, true],
      ['Acquitter l’alarme', WIDGET_ACTIONS.RESET_ALARM, false],
      ['Test micro-fuite', WIDGET_ACTIONS.MICROLEAK_TEST, true],
    ],
  );
  const status = content.components.find((component) => component.type === 'status');
  assert.ok(status.items.some((item) => item.value === 'Fuite : durée maximale atteinte'));
  let ack = await gladys.fake.widgetAction(WIDGETS.OVERVIEW, WIDGET_ACTIONS.CLOSE_VALVE, {
    device: TRIO_ID,
  });
  assert.equal(ack.success, true, ack.error);
  assert.equal(trio.closed, true);
  assert.equal(ack.data.message.fr, 'Eau coupée : SYR SafeTech Plus Connect 112ABC00042');
  ack = await gladys.fake.widgetAction(WIDGETS.OVERVIEW, WIDGET_ACTIONS.RESET_ALARM, {
    device: TRIO_ID,
  });
  assert.equal(ack.success, true, ack.error);
  assert.equal(trio.alarm, 'ff');
  content = await widget(gladys, WIDGETS.OVERVIEW, {
    language: 'en',
    settings: { device: id(TRIO_ID) },
  });
  assert.deepEqual(
    content.components.filter((c) => c.type === 'button').map((c) => c.action.key),
    [WIDGET_ACTIONS.OPEN_VALVE],
    'closed: open it again, no test',
  );
  // Two days of readings: the chart appears.
  clock.now += 24 * HOUR;
  trio.totalL += 180;
  await run(env, 30 * SECOND);
  content = await widget(gladys, WIDGETS.CONSUMPTION, { language: 'de', settings: {} });
  const chart = content.components.find((component) => component.type === 'chart');
  assert.equal(chart.series[0].points.length, 2);
  assert.deepEqual(validateWidgetContent(content).errors ?? [], []);
});

test('no address, or an address that is no SYR device: a clear status', async (t) => {
  const empty = await startApp(t, { config: { hosts: '' } });
  await run(empty, 30 * SECOND);
  assert.equal(empty.gladys.fake.connectionStatus.connected, false);
  assert.match(empty.gladys.fake.connectionStatus.message.en, /Type the address/);
  const box = await startApp(t, {
    config: { hosts: '192.168.1.1' },
    devices: { '192.168.1.1': null },
  });
  const ack = await box.gladys.fake.action(ACTIONS.SEARCH);
  assert.equal(
    ack.data.message.en,
    '192.168.1.1 answers, but not as a SYR device with a local API.',
  );
  assert.deepEqual(
    box.network.calls.map((call) => call.path),
    ['/trio/get/all', '/safe-tec/set/ADM/(2)f', '/safe-tec/get/all', '/pontos-base/get/all'],
  );
  const content = await widget(box.gladys, WIDGETS.OVERVIEW, { language: 'en' });
  assert.deepEqual(validateWidgetContent(content).errors ?? [], []);
});

test('a restart of the container keeps the devices and the days of water', async (t) => {
  const dir = dataDir();
  const first = await startApp(t, { dir });
  await run(first, 30 * SECOND);
  await first.gladys.fake.shutdown();
  const second = await startApp(t, { dir });
  assert.equal(second.app.store.data.devices[TRIO_ID].model, 'SafeTech Plus Connect');
  assert.ok(Object.keys(second.app.store.data.devices[TRIO_ID].usage.days).length === 1);
  assert.equal(second.gladys.fake.discoveredDevices.length, 2, 'offered again at once');
});

test('diagnostic: in the logs', async (t) => {
  const env = await startApp(t);
  await run(env, 30 * SECOND);
  const ack = await env.gladys.fake.action(ACTIONS.DIAGNOSTIC);
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data.message.en, /Diagnostic written/);
  assert.ok(env.logger.lines.some(([, line]) => line.includes('SYR diagnostic 1/')));
});
