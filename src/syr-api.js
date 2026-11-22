// -----------------------------------------------------------------------------
// HTTP client of a SYR device on the local network (local JSON API, port 5333).
//
// The SYR leak protection devices (SafeTech, SafeTech+, Trio, SafeTech Lock,
// TRIO Lock, Hansgrohe Pontos Base and their twins of other brands) answer
// plain GET requests on port 5333 with a flat JSON object:
//   GET /<family>/get/all          every value ({"getAB": false, "getVOL": 7094, …})
//   GET /<family>/set/<cmd>/<val>  a command ({"setABtrue": "OK"})
//   GET /<family>/clr/ala          clear the alarm of the older SafeTech
//   GET /<family>/set/ADM/(2)f     "expert mode", needed by the older firmwares
//                                  before /get/all reports every value (404 elsewhere)
// No authentication. The firmwares do not decode percent-encoded characters:
// the paths are sent as they are. They send no Content-Type header: the body
// is parsed as JSON whatever it says.
//
// One request at a time per device (a queue), no keep-alive, a 10-second
// timeout, a short pause between requests: the boards are small and the
// valve motor runs on the same controller.
// -----------------------------------------------------------------------------

import http from 'node:http';

const DEFAULT_PORT = 5333;
const TIMEOUT_MS = 10000;
const SPACING_MS = 200;
const MAX_BODY = 512 * 1024;

/**
 * @description An error of a device.
 */
class SyrError extends Error {
  /**
   * @param {string} kind - `unreachable` (no answer, timeout), `http` (a
   * status other than 200; `status` tells which), `invalid` (not the answer
   * of a SYR device), `refused` (the device answered a command with an error
   * code: `code` tells which, MIMA or NSC).
   * @param {string} message - What went wrong.
   * @param {object} [extra] - `{ status, code }`.
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'SyrError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

/**
 * @description One HTTP GET with node:http, without keep-alive.
 * @param {object} options - `{ host, port, path, headers, timeout }`.
 * @returns {Promise<{ status: number, body: string }>} The answer.
 */
function httpRequest({ host, port, path, headers = {}, timeout }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host, port, path, method: 'GET', headers, agent: false, timeout },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY) {
            request.destroy(new Error('answer too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        );
        response.on('error', reject);
      },
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

/**
 * @description Split "192.168.1.20", "safetech.local:5333" or "[fe80::1]:5333".
 * @param {string} address - The address.
 * @returns {{ host: string, port: number }} The host and the port (5333 by default).
 */
function splitAddress(address) {
  const text = String(address ?? '').trim();
  const bracket = text.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracket) {
    return { host: bracket[1], port: Number(bracket[2] ?? DEFAULT_PORT) };
  }
  const colon = text.match(/^([^:]+):(\d+)$/);
  if (colon) {
    return { host: colon[1], port: Number(colon[2]) };
  }
  return { host: text, port: DEFAULT_PORT };
}

/**
 * @description The client of one device address.
 * @param {object} options - Options.
 * @param {string} options.address - IP address or name (optionally `:port`).
 * @param {Function} [options.request] - Transport (tests): `({ host, port, path, headers, timeout }) => answer`.
 * @param {Function} [options.sleep] - `(ms) => Promise` (tests).
 * @returns {object} `{ address, host, port, getJson, counts }`.
 */
function createSyrClient({ address, request = httpRequest, sleep }) {
  const { host, port } = splitAddress(address);
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let queue = Promise.resolve();
  const counts = { requests: 0, failures: 0 };

  /**
   * @description One GET, queued behind the others to this device, parsed as JSON.
   * @param {string} path - The path, sent as it is.
   * @returns {Promise<object>} The JSON object of a 200 answer.
   */
  function getJson(path) {
    const run = queue.then(async () => {
      counts.requests += 1;
      try {
        let answer;
        try {
          answer = await request({
            host,
            port,
            path,
            headers: { Connection: 'close', Accept: 'application/json' },
            timeout: TIMEOUT_MS,
          });
        } catch (err) {
          counts.failures += 1;
          throw new SyrError('unreachable', `${address}: ${err.message}`);
        }
        if (answer.status !== 200) {
          counts.failures += 1;
          throw new SyrError('http', `${address}${path}: HTTP ${answer.status}`, {
            status: answer.status,
          });
        }
        let data;
        try {
          data = JSON.parse(String(answer.body ?? '').trim() || 'null');
        } catch {
          data = null;
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          counts.failures += 1;
          throw new SyrError('invalid', `${address}${path}: not a JSON object`);
        }
        return data;
      } finally {
        await wait(SPACING_MS);
      }
    });
    // A failure never blocks the next request.
    queue = run.catch(() => {});
    return run;
  }

  return { address, host, port, getJson, counts: () => ({ ...counts }) };
}

export {
  SyrError,
  DEFAULT_PORT,
  TIMEOUT_MS,
  SPACING_MS,
  httpRequest,
  splitAddress,
  createSyrClient,
};
