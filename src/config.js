// -----------------------------------------------------------------------------
// Configuration of the SYR integration.
//
// Fields of the config_schema:
//   - `hosts`     the addresses of the devices (IP or name, optionally
//                 `:port`, 5333 by default), comma separated: the devices do
//                 not announce themselves on the network, so they are typed in;
//   - `interval`  how often the devices are read: 10, 30 (default) or 60 s;
//   - `language`  language of the texts Gladys does not ask for in a
//                 language (feature names, alarm texts, scene texts): `auto`
//                 follows the language of the last widget, or the timezone.
//
// Internal key, outside the config_schema (never shown in the UI):
//   - `last_language` language of the last widget request.
// -----------------------------------------------------------------------------

import { isLanguage } from './i18n.js';

const AUTO_LANGUAGE = 'auto';
const INTERNAL_KEYS = { language: 'last_language' };
const INTERVALS = [10, 30, 60];
const DEFAULT_INTERVAL = 30;
const MAX_HOSTS = 10;

const readString = (raw) =>
  typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';

/**
 * @description The addresses typed in the configuration.
 * @param {unknown} value - "192.168.1.30, safetech.local:5333".
 * @returns {string[]} The addresses, without duplicates.
 */
function parseHosts(value) {
  const list = String(value ?? '')
    .split(/[\s,;]+/)
    .map((entry) =>
      entry
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/.*$/, ''),
    )
    .filter((entry) => /^[A-Za-z0-9.:[\]_-]{1,253}$/.test(entry));
  return [...new Set(list.map((entry) => entry.toLowerCase()))].slice(0, MAX_HOSTS);
}

/**
 * @description Normalize the raw config object from the host API.
 * @param {object} [rawConfig] - The raw config values.
 * @returns {object} `{ hosts, interval, language }`.
 * @example
 * normalizeConfig({ hosts: '192.168.1.30', interval: '10' }); // interval 10
 */
function normalizeConfig(rawConfig = {}) {
  const config = rawConfig ?? {};
  const interval = Number(readString(config.interval));
  return {
    hosts: parseHosts(config.hosts),
    interval: INTERVALS.includes(interval) ? interval : DEFAULT_INTERVAL,
    language: isLanguage(config.language) ? config.language : AUTO_LANGUAGE,
  };
}

// The timezones of the countries that speak the languages of the integration:
// the automatic language before any widget was shown.
const TIMEZONE_LANGUAGES = {
  fr: [
    'Europe/Paris',
    'Europe/Monaco',
    'Europe/Brussels',
    'Europe/Luxembourg',
    'Indian/Reunion',
    'Indian/Mayotte',
    'America/Guadeloupe',
    'America/Martinique',
    'America/Cayenne',
    'America/Miquelon',
    'Pacific/Noumea',
    'Pacific/Tahiti',
    'America/Montreal',
    'Africa/Abidjan',
    'Africa/Dakar',
    'Africa/Casablanca',
    'Africa/Algiers',
    'Africa/Tunis',
  ],
  de: ['Europe/Berlin', 'Europe/Busingen', 'Europe/Vienna', 'Europe/Zurich', 'Europe/Vaduz'],
  es: [
    'Europe/Madrid',
    'Atlantic/Canary',
    'Africa/Ceuta',
    'America/Mexico_City',
    'America/Bogota',
    'America/Lima',
    'America/Santiago',
    'America/Caracas',
    'America/Montevideo',
    'America/Asuncion',
    'America/La_Paz',
    'America/Guayaquil',
    'America/Havana',
    'America/Costa_Rica',
    'America/Panama',
  ],
};

/**
 * @description The language of the texts guessed from a timezone, before
 * any widget was shown.
 * @param {string} timezone - IANA timezone of Gladys.
 * @returns {string} en, fr, de or es.
 * @example
 * guessLanguage('Europe/Paris'); // -> 'fr'
 */
function guessLanguage(timezone) {
  const zone = String(timezone ?? '');
  if (zone.startsWith('America/Argentina/')) {
    return 'es';
  }
  const found = Object.entries(TIMEZONE_LANGUAGES).find(([, zones]) => zones.includes(zone));
  return found ? found[0] : 'en';
}

/**
 * @description Read the stored language of the last widget request.
 * @param {object} [rawConfig] - The raw config values.
 * @param {string} fallback - The language to keep when nothing valid is stored.
 * @returns {string} The language.
 */
function readLanguage(rawConfig, fallback) {
  const language = (rawConfig ?? {})[INTERNAL_KEYS.language];
  return isLanguage(language) ? language : fallback;
}

export {
  AUTO_LANGUAGE,
  INTERNAL_KEYS,
  INTERVALS,
  DEFAULT_INTERVAL,
  MAX_HOSTS,
  parseHosts,
  normalizeConfig,
  guessLanguage,
  readLanguage,
};
