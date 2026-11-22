// The devices offered on the Discovery screen, checked like the core checks
// them (a single invalid field rejects the whole batch, and a missing min /
// max / read_only / has_feedback makes "Add" fail in 422).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  buildDevice,
  buildStates,
  seenFeatures,
  idOf,
  deviceName,
  alarmText,
  FEATURES,
} from '../src/device.js';
import { parseStatus } from '../src/syr.js';
import { LANGUAGES } from '../src/i18n.js';
import { syrState, getAll } from './helpers/fake-syr.js';

const fakeGladys = {
  externalIds: (type, id) => ({
    device: `ext:test-integration:${type}:${id}`,
    feature: (key) => `ext:test-integration:${type}:${id}:${key}`,
  }),
};

// The pairs of the core (DEVICE_FEATURE_UNITS_BY_CATEGORY and the units by
// type, Gladys master 2026-11-20).
const UNITS_OF = {
  [C.SWITCH]: [null],
  [C.LEAK_SENSOR]: [null],
  [C.TEXT]: [null],
  [C.WATER_VALVE]: [U.CUBIC_METER_PER_HOUR],
  [C.PRESSURE_SENSOR]: [U.BAR],
  [C.TEMPERATURE_SENSOR]: [U.CELSIUS],
  [C.VOLUME_SENSOR]: [U.LITER, U.CUBIC_METER],
  [C.BATTERY]: [U.PERCENT],
  [C.BATTERY_LOW]: [null],
};
const TYPES_OF = {
  [C.SWITCH]: [T.SWITCH.BINARY],
  [C.LEAK_SENSOR]: [T.SENSOR.BINARY],
  [C.TEXT]: [T.TEXT.TEXT, T.TEXT.SELECT],
  [C.WATER_VALVE]: [T.WATER_VALVE.FLOW],
  [C.PRESSURE_SENSOR]: [T.SENSOR.DECIMAL],
  [C.TEMPERATURE_SENSOR]: [T.SENSOR.DECIMAL],
  [C.VOLUME_SENSOR]: [T.VOLUME_SENSOR.DECIMAL],
  [C.BATTERY]: [T.BATTERY.INTEGER],
  [C.BATTERY_LOW]: [T.BATTERY_LOW.BINARY],
};

/**
 * @description A stored device after one reading of a fake one.
 * @param {string} kind - `trio`, `safetec` or `pontos`.
 * @param {object} [overrides] - Fake state values.
 * @returns {object} The device.
 */
function stored(kind, overrides = {}) {
  const path = { trio: '/trio', safetec: '/safe-tec', pontos: '/pontos-base' }[kind];
  const { id, ...values } = parseStatus(getAll(syrState(kind, { adm: true, ...overrides })), path);
  const device = { id, serial: values.serial, path, model: values.model, values, present: {} };
  for (const key of seenFeatures(values)) device.present[key] = true;
  return device;
}

const keysOf = (device) => device.features.map((feature) => feature.external_id.split(':').pop());

test('every feature is complete and uses a category / type / unit pair of the core', () => {
  for (const language of LANGUAGES) {
    for (const kind of ['trio', 'safetec', 'pontos']) {
      const device = buildDevice(fakeGladys, stored(kind), { language });
      assert.equal(device.should_poll, false);
      assert.equal(device.poll_frequency, undefined, 'its own timer');
      assert.ok(device.name.length <= 100);
      for (const feature of device.features) {
        for (const key of ['name', 'external_id', 'category', 'type', 'min', 'max']) {
          assert.ok(feature[key] !== undefined, `${feature.external_id}: ${key}`);
        }
        assert.equal(typeof feature.read_only, 'boolean');
        assert.equal(typeof feature.has_feedback, 'boolean');
        assert.ok(feature.min <= feature.max);
        assert.ok(UNITS_OF[feature.category]?.includes(feature.unit), feature.external_id);
        assert.ok(TYPES_OF[feature.category]?.includes(feature.type), feature.external_id);
      }
    }
  }
  for (const spec of Object.values(FEATURES)) {
    assert.ok(Object.values(C).includes(spec.category));
  }
});

test('a Trio-family device: valve, profile select, battery level, every measurement', () => {
  const device = buildDevice(fakeGladys, stored('trio'), { language: 'fr' });
  assert.equal(device.name, 'SYR SafeTech Plus Connect 112ABC00042');
  assert.equal(device.external_id, 'ext:test-integration:syr:112abc00042');
  assert.deepEqual(keysOf(device), [
    'valve',
    'leak',
    'alarm',
    'profile',
    'flow',
    'pressure',
    'temperature',
    'total_volume',
    'today_volume',
    'last_volume',
    'current_volume',
    'battery',
    'battery_low',
  ]);
  const valve = device.features[0];
  assert.equal(valve.name, 'Arrivée d’eau');
  assert.equal(valve.read_only, false);
  assert.equal(valve.has_feedback, true);
  const profile = device.features.find((feature) => feature.external_id.endsWith(':profile'));
  assert.equal(profile.read_only, false);
  assert.deepEqual(profile.supported_options, [
    { value: '1', label: 'Anwesend', sort_order: 0 },
    { value: '2', label: 'Abwesend', sort_order: 1 },
    { value: '3', label: 'Urlaub', sort_order: 2 },
  ]);
  assert.deepEqual(device.params, [
    { name: 'SYR_SERIAL', value: '112ABC00042' },
    { name: 'SYR_PATH', value: '/trio' },
    { name: 'SYR_ADDRESS', value: '' },
  ]);
});

test('older SafeTech: no battery level; Pontos Base: no valve switch', () => {
  assert.ok(!keysOf(buildDevice(fakeGladys, stored('safetec'))).includes('battery'));
  assert.ok(keysOf(buildDevice(fakeGladys, stored('safetec'))).includes('valve'));
  const pontos = keysOf(buildDevice(fakeGladys, stored('pontos')));
  assert.ok(!pontos.includes('valve'));
  assert.ok(pontos.includes('profile'));
  assert.equal(
    deviceName({ model: 'Hansgrohe Pontos Base', serial: '000000777' }),
    'Hansgrohe Pontos Base 000000777',
  );
});

test('states: valve 1 = water flows, flow in m³/h, meter in m³, alarm in words', () => {
  const device = stored('trio', {
    closed: true,
    motor: 10,
    flowLh: 540,
    totalL: 130007,
    alarm: 'a5',
  });
  const states = Object.fromEntries(
    buildStates(fakeGladys, device, { language: 'de', todayLiters: 212.4 }).map((state) => [
      state.device_feature_external_id.split(':').pop(),
      state.state ?? state.text,
    ]),
  );
  assert.deepEqual(states, {
    valve: 0,
    leak: 1,
    alarm: 'Leck: Durchflussgrenze erreicht',
    profile: '1',
    flow: 0.54,
    pressure: 4.1,
    temperature: 11.8,
    total_volume: 130.007,
    today_volume: 212,
    last_volume: 3,
    current_volume: 0,
    battery: 100,
    battery_low: 0,
  });
  const quiet = buildStates(fakeGladys, stored('trio'), { language: 'en' });
  assert.equal(
    quiet.find((state) => state.device_feature_external_id.endsWith(':alarm')).text,
    'No alarm',
  );
  assert.equal(quiet.find((state) => state.device_feature_external_id.endsWith(':valve')).state, 1);
});

test('unknown codes keep their code; external ids read back', () => {
  assert.equal(alarmText({ alarm: 'other', alarmCode: '0B' }, 'fr'), 'Alarme 0B');
  assert.equal(alarmText({ alarm: null }, 'fr'), '');
  assert.equal(idOf('ext:test-integration:syr:112abc00042'), '112abc00042');
  assert.equal(idOf('ext:test-integration:syr:112abc00042:valve'), '112abc00042');
  assert.equal(idOf('ext:test-integration:other:1'), null);
  assert.equal(idOf(undefined), null);
});
