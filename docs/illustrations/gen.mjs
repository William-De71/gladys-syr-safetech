// Widget contents for the generated illustrations, built by the real code of
// the integration: the app itself (src/app.js) wired to the fake Gladys of the
// SDK and the fake SYR devices of the tests (test/helpers/fake-syr.js), over
// 14 days up to Sunday, 22 November 2026 at 14:15 in Paris. The made-up
// house: a SafeTech Plus on the main water supply (a family of four: showers
// in the morning and the evening, a washing machine every other day, more
// water at the weekend; someone runs a bath right now), and an older SafeTech
// V4 in the holiday flat that has just shut the water off on a leak.
// Smooth made-up values (no randomness): never real data.
// Written as JSON for render.js: node gen.mjs <repo> <out.json>

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [repo, out] = process.argv.slice(2);
const load = (file) => import(pathToFileURL(join(repo, file)).href);
const { createApp } = await load('src/app.js');
const { LANGUAGES } = await load('src/i18n.js');
const { createFakeGladys } = await import(
  pathToFileURL(join(repo, 'node_modules/@gladysassistant/integration-sdk/lib/testing.js')).href
);
const { fakeNetwork, syrState, dataDir, recordingLogger } = await load('test/helpers/fake-syr.js');

const NOW = Date.parse('2026-11-22T13:15:00Z');
const DAYS = 14;
const STEP = 30 * 60000;
const MAIN = '192.168.1.40';
const FLAT = '192.168.1.41';
const MAIN_ID = '112abc00042';
const FLAT_ID = '987650001';
const manifest = JSON.parse(readFileSync(join(repo, 'gladys-assistant-integration.json'), 'utf8'));
// The three cards drawn.
const CARDS = {
  overview: { widget: 'overview', settings: { device: `ext:test-integration:syr:${MAIN_ID}` } },
  consumption: {
    widget: 'consumption',
    settings: { device: `ext:test-integration:syr:${MAIN_ID}` },
  },
  flat: { widget: 'overview', settings: { device: `ext:test-integration:syr:${FLAT_ID}` } },
};
// The names a user would give the devices in Gladys, and the profile names of the SYR app.
const NAMES = {
  en: { main: 'Main water supply', flat: 'Holiday flat', profiles: ['Home', 'Away', 'Holidays'] },
  fr: {
    main: 'Arrivée d’eau',
    flat: 'Gîte',
    profiles: ['Présent', 'Absent', 'Vacances'],
  },
  de: {
    main: 'Hauptwasserzufuhr',
    flat: 'Ferienwohnung',
    profiles: ['Anwesend', 'Abwesend', 'Urlaub'],
  },
  es: {
    main: 'Agua de la casa',
    flat: 'Apartamento',
    profiles: ['En casa', 'Ausente', 'Vacaciones'],
  },
};

// Local hours of Paris (UTC+1 in November).
const hourOf = (ms) => (((ms / 3600000 + 1) % 24) + 24) % 24;
const dayIndex = (ms) => Math.floor((ms / 3600000 + 1) / 24);
const bump = (hour, from, to) =>
  hour >= from && hour < to ? Math.sin((Math.PI * (hour - from)) / (to - from)) : 0;
// Liters drawn per hour at an instant.
const litersPerHour = (ms) => {
  const hour = hourOf(ms);
  const day = dayIndex(ms);
  const weekend = [3, 4].includes(((day % 7) + 7) % 7) ? 1.25 : 1;
  const washing = day % 2 === 0 ? 55 * bump(hour, 10, 12) : 0;
  return (
    0.65 *
      weekend *
      (8 +
        70 * bump(hour, 6.5, 8.5) +
        25 * bump(hour, 11.5, 13.5) +
        60 * bump(hour, 18.5, 21.5) +
        12 * Math.sin(day * 1.7) ** 2) +
    washing
  );
};

/**
 * @description One language: the app run for 14 days, then the widgets.
 * @param {string} language - Language.
 * @returns {Promise<object>} The widget contents.
 */
async function contents(language) {
  const clock = { now: NOW - DAYS * 24 * 3600000 };
  const main = syrState('trio', {
    totalL: 318420,
    profiles: NAMES[language].profiles,
    pressureMbar: 4300,
    temperatureTenths: 124,
  });
  const flat = syrState('safetec', {
    totalL: 41260,
    pressureMbar: 3800,
    temperatureTenths: 141,
    profiles: NAMES[language].profiles.slice(0, 2),
    profile: 2,
  });
  const network = fakeNetwork({ [MAIN]: main, [FLAT]: flat });
  const gladys = createFakeGladys({ config: { hosts: `${MAIN}, ${FLAT}`, language } });
  const app = createApp(gladys, {
    request: network.request,
    dataDir: dataDir(),
    now: () => clock.now,
    sleep: async () => {},
    timeZone: 'Europe/Paris',
    timers: false,
    logger: recordingLogger(),
  });
  await gladys.connect();
  await app.whenReady();
  let created = false;
  let total = main.totalL;
  while (clock.now <= NOW) {
    total += (litersPerHour(clock.now) * STEP) / 3600000;
    main.totalL = Math.round(total);
    main.flowLh = 0;
    // The flat is let: a little water now and then, then the leak this morning.
    flat.totalL += Math.floor(hourOf(clock.now)) === 9 ? 12 : 0;
    await app.tick();
    if (!created) {
      for (const discovered of gladys.fake.discoveredDevices) {
        const key = discovered.external_id.includes(MAIN_ID) ? 'main' : 'flat';
        await gladys.fake.deviceCreated({
          ...structuredClone(discovered),
          name: NAMES[language][key],
        });
      }
      created = true;
    }
    clock.now += STEP;
  }
  // Now: a bath running at home, a leak in the holiday flat (the valve shut it off).
  clock.now = NOW;
  main.flowLh = 702;
  main.currentMl = 63500;
  flat.alarm = 'A4';
  flat.closed = true;
  flat.motor = 10;
  await app.tick();
  const result = {};
  for (const [name, { widget, settings }] of Object.entries(CARDS)) {
    result[name] = (await gladys.fake.widgetGet(widget, { settings, language })).data.content;
  }
  await gladys.fake.shutdown();
  return result;
}

const all = {};
for (const language of LANGUAGES) {
  all[language] = await contents(language);
}

const card = (key) => {
  const widget = manifest.widgets.find((item) => item.key === key);
  return { icon: widget.icon, label: widget.label };
};
writeFileSync(
  out,
  JSON.stringify({
    contents: all,
    images: {},
    cards: Object.fromEntries(
      Object.entries(CARDS).map(([name, { widget }]) => [name, card(widget)]),
    ),
    now: NOW,
  }),
);
