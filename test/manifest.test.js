import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TRIGGERS, SCENE_ACTIONS, OUTPUTS } from '../src/events.js';
import { ACTIONS } from '../src/app.js';
import { WIDGETS } from '../src/widgets.js';
import { AUTO_LANGUAGE, INTERVALS, DEFAULT_INTERVAL, normalizeConfig } from '../src/config.js';
import { LANGUAGES } from '../src/i18n.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const manifest = read('../gladys-assistant-integration.json');
const pkg = read('../package.json');
const byKey = (list) => new Map(list.map((entry) => [entry.key, entry]));
const values = (field) => field.options.map((option) => option.value);
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const REPO = 'William-De71/gladys-syr-safetech';

test('a device integration, in lockstep with package.json, at 0.x until 1.0.0 is decided', () => {
  assert.equal(manifest.type, 'device');
  assert.equal(manifest.name, 'SYR SafeTech');
  assert.equal(manifest.version, pkg.version);
  assert.match(pkg.version, /^0\./);
  assert.equal(manifest.docker_image, `ghcr.io/william-de71/gladys-syr-safetech:${pkg.version}`);
  assert.equal(manifest.cover_image, `https://raw.githubusercontent.com/${REPO}/main/cover.jpg`);
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.name, 'gladys-syr-safetech');
});

test('declares the local transport: the devices over HTTP, every request through the client', () => {
  assert.deepEqual(manifest.transports, ['local']);
  assert.match(source('../src/syr-api.js'), /from 'node:http'/);
  for (const file of [
    'app',
    'syr',
    'consumption',
    'events',
    'widgets',
    'device',
    'store',
    'time',
    'config',
  ]) {
    assert.doesNotMatch(
      source(`../src/${file}.js`),
      /fetch\(|node:https?|node:net|node:dgram/,
      file,
    );
  }
  // A single channel: no transport to publish per device.
  assert.doesNotMatch(source('../src/app.js'), /publishTransports|GLADYS_PREFER_LOCAL/);
});

test('Gladys 5.3.0 for the catalog keywords, worldwide, no network discovery', () => {
  assert.equal(manifest.gladys_version, '>=5.3.0');
  assert.deepEqual(manifest.categories, ['security', 'appliances']);
  assert.equal(manifest.countries, undefined, 'sold in many countries');
  assert.ok(manifest.keywords.length >= 1 && manifest.keywords.length <= 10);
  const lower = manifest.keywords.map((word) => word.toLowerCase());
  assert.equal(new Set(lower).size, lower.length, 'unique keywords');
  for (const word of manifest.keywords) {
    assert.ok(word.length >= 2 && word.length <= 30, word);
  }
  // The devices do not announce themselves: the addresses are typed.
  for (const key of [
    'network_discovery',
    'location',
    'network_wake',
    'containers',
    'webhooks',
    'messaging',
    'energy_contracts',
    'music',
  ]) {
    assert.equal(manifest[key], undefined, key);
  }
});

test('config_schema: the fields the code reads, with their defaults', () => {
  const config = byKey(manifest.config_schema);
  assert.equal(config.get('hosts').type, 'string');
  assert.equal(config.get('hosts').required, true);
  assert.deepEqual(values(config.get('interval')).map(Number), INTERVALS);
  assert.equal(Number(config.get('interval').default), DEFAULT_INTERVAL);
  assert.deepEqual(values(config.get('language')), [AUTO_LANGUAGE, ...LANGUAGES]);
  assert.equal(config.get('language').default, AUTO_LANGUAGE);
  for (const field of manifest.config_schema) {
    assert.ok(!['text', 'password'].includes(field.type), `${field.key}: string / secret only`);
  }
  assert.deepEqual(normalizeConfig(), {
    hosts: [],
    interval: 30,
    language: AUTO_LANGUAGE,
  });
  assert.equal(normalizeConfig({ language: 'it' }).language, AUTO_LANGUAGE);
  assert.equal(normalizeConfig({ interval: '10' }).interval, 10);
  assert.equal(normalizeConfig({ interval: 15 }).interval, 30);
  assert.deepEqual(
    normalizeConfig({ hosts: 'http://192.168.1.40/, safetech.local:5333 ; X' }).hosts,
    ['192.168.1.40', 'safetech.local:5333', 'x'],
  );
});

test('configuration actions, widgets, triggers and the scene action match the code', () => {
  assert.deepEqual(
    manifest.actions.map((action) => action.key),
    Object.values(ACTIONS),
  );
  assert.deepEqual(
    manifest.widgets.map((widget) => widget.key),
    Object.values(WIDGETS),
  );
  assert.deepEqual(
    manifest.scene_triggers.map((trigger) => trigger.key),
    Object.values(TRIGGERS),
  );
  assert.deepEqual(
    manifest.scene_actions.map((action) => action.key),
    Object.values(SCENE_ACTIONS),
  );
  for (const action of manifest.scene_actions) {
    assert.deepEqual(
      action.outputs.map((output) => output.key),
      OUTPUTS[action.key],
      action.key,
    );
  }
  for (const action of manifest.scene_actions) {
    assert.ok(action.timeout_seconds >= 5 && action.timeout_seconds <= 120, action.key);
  }
  for (const trigger of manifest.scene_triggers) {
    assert.ok((trigger.fields ?? []).length <= 10, trigger.key);
    assert.ok(trigger.variables.length <= 20, trigger.key);
    for (const field of trigger.fields ?? []) {
      // A field filters by equality on the key of the same name of the data.
      assert.ok(
        trigger.variables.some((variable) => variable.key === field.key),
        `${trigger.key}.${field.key}`,
      );
    }
  }
  for (const widget of manifest.widgets) {
    for (const setting of widget.settings ?? []) {
      assert.ok(!['secret', 'oauth2', 'account_link'].includes(setting.type), setting.key);
    }
  }
});
