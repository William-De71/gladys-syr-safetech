// -----------------------------------------------------------------------------
// Entry point of the SYR leak protection external integration.
//
// The SYR leak protection devices of the local network (local JSON API, port 5333):
//   - devices: one per SYR device: shut-off valve, leak alarm, alarm text,
//     profile, flow, pressure, temperature, water volumes, battery,
//     offered on the Discovery screen (src/device.js);
//   - scene triggers: leak detected, alarm raised, alarm cleared, warning
//     raised, unreachable, back online;
//   - scene actions: select a profile, start the microleak test, reset the
//     alarm, water used;
//   - dashboard widgets: overview (with buttons), water per day.
//
// This file only wires the SDK client: the handlers are in src/app.js.
//
// Environment variables provided by the Gladys supervisor:
//   GLADYS_HOST_API_URL / GLADYS_INTEGRATION_TOKEN / GLADYS_INTEGRATION_SELECTOR
//   TZ (the timezone of Gladys)
// The SDK reads the first three: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { createApp } from './src/app.js';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const gladys = new GladysIntegration();
createApp(gladys);

// --- Startup -----------------------------------------------------------------------
logger.info(`Starting the SYR integration ${version}...`);
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
