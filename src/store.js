// -----------------------------------------------------------------------------
// What the integration keeps across restarts, under /data (the only writable
// place of the container), in /data/syr.json (mode 0600):
//
//   - `devices`   per device, by id (its serial number): address, path, model,
//                 last values, the features seen, the first total volume of
//                 each day (`usage`), reachability for the triggers (`seen`);
//   - `addresses` the path recognised at each typed address;
//   - `lastError` the last error (diagnostic).
// -----------------------------------------------------------------------------

import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PATHS } from './syr.js';

const DEFAULT_DIR = '/data';
const FILE = 'syr.json';
const EMPTY = () => ({ devices: {}, addresses: {}, lastError: null });

/**
 * @description Read a JSON file; an absent or broken file is null.
 * @param {string} path - The file.
 * @param {object} [logger] - Logger.
 * @returns {Promise<object|null>} The value.
 */
async function readJson(path, logger) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger?.warn(`Unable to read ${path}: ${err.message}`);
    }
    return null;
  }
}

/**
 * @description Write a JSON file atomically (a temporary file, then a
 * rename), readable by its owner only.
 * @param {string} path - The file.
 * @param {object} value - The value.
 * @param {object} [logger] - Logger.
 * @returns {Promise<void>}
 */
async function writeJson(path, value, logger) {
  try {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (err) {
    logger?.warn(`Unable to write ${path}: ${err.message}`);
  }
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * @description The store.
 * @param {object} [options] - `{ dir, logger }`.
 * @returns {object} `{ data, load, save, reset, path }`.
 */
function createStore({ dir = DEFAULT_DIR, logger } = {}) {
  const path = join(dir, FILE);
  let writing = Promise.resolve();
  const store = {
    path,
    data: EMPTY(),
    /**
     * @description Read the file.
     * @returns {Promise<void>}
     */
    async load() {
      const raw = (await readJson(path, logger)) ?? {};
      const data = EMPTY();
      if (isObject(raw.devices)) {
        for (const [id, device] of Object.entries(raw.devices)) {
          if (/^[0-9a-z]{1,32}$/.test(id) && isObject(device)) {
            const usage = isObject(device.usage) ? device.usage : {};
            data.devices[id] = {
              ...device,
              id,
              values: isObject(device.values) ? device.values : {},
              present: isObject(device.present) ? device.present : {},
              usage: { ...usage, days: isObject(usage.days) ? usage.days : {} },
            };
          }
        }
      }
      if (isObject(raw.addresses)) {
        for (const [address, path] of Object.entries(raw.addresses)) {
          if (PATHS.includes(path)) data.addresses[address] = path;
        }
      }
      data.lastError = isObject(raw.lastError) ? raw.lastError : null;
      store.data = data;
    },
    /**
     * @description Forget everything.
     */
    reset() {
      store.data = EMPTY();
    },
    /**
     * @description Write the state (one write at a time).
     * @returns {Promise<void>}
     */
    save() {
      writing = writing.then(() => writeJson(path, store.data, logger));
      return writing;
    },
  };
  return store;
}

export { DEFAULT_DIR, FILE, createStore };
