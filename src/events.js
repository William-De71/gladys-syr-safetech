// -----------------------------------------------------------------------------
// Scene triggers and scene actions of the SYR integration.
//
// Triggers (once per transition, worked out after each reading, never at the
// first reading of a device, never from a scene action):
//   - leak_detected       a leak alarm became active (volume, duration, flow,
//                         microleak, external sensor): the device has usually
//                         shut the water off by itself;
//   - alarm_raised        any alarm became active (leaks included);
//   - alarm_cleared       the alarm went away (reset on the device, in its app
//                         or from Gladys);
//   - warning_raised      a warning became active (power cut, battery, leak
//                         warning…; newer devices only);
//   - device_unreachable  no answer UNREACHABLE_AFTER times in a row, and for
//                         at least UNREACHABLE_MIN_MS;
//   - device_back_online  it answers again.
//
// Scene actions:
//   - set_profile           select a leak protection profile (1 to 8);
//   - start_microleak_test  close the valve about 4 minutes to test the pipes;
//   - reset_alarm           clear the current alarm (the valve stays as it is);
//   - get_consumption       today's, yesterday's and the total water.
// -----------------------------------------------------------------------------

const TRIGGERS = {
  LEAK: 'leak_detected',
  ALARM: 'alarm_raised',
  ALARM_CLEARED: 'alarm_cleared',
  WARNING: 'warning_raised',
  UNREACHABLE: 'device_unreachable',
  BACK_ONLINE: 'device_back_online',
};
const SCENE_ACTIONS = {
  SET_PROFILE: 'set_profile',
  MICROLEAK_TEST: 'start_microleak_test',
  RESET_ALARM: 'reset_alarm',
  GET_CONSUMPTION: 'get_consumption',
};
const OUTPUTS = {
  set_profile: ['device_name', 'profile', 'profile_name', 'summary'],
  start_microleak_test: ['device_name', 'summary'],
  reset_alarm: ['device_name', 'previous_alarm', 'summary'],
  get_consumption: [
    'device_name',
    'today_liters',
    'yesterday_liters',
    'total_m3',
    'flow_lpm',
    'valve_open',
    'summary',
  ],
};
const UNREACHABLE_AFTER = 3;
const UNREACHABLE_MIN_MS = 60 * 1000;

/**
 * @description Keep only the declared keys of an object (outputs).
 * @param {object} values - The values.
 * @param {string[]} keys - The declared keys.
 * @returns {object} The kept values, without the null ones.
 */
function pick(values, keys) {
  return Object.fromEntries(
    keys
      .filter((key) => values[key] !== undefined && values[key] !== null)
      .map((key) => [key, values[key]]),
  );
}

/**
 * @description A number rounded to some decimals.
 * @param {number|null} value - The value.
 * @param {number} decimals - The decimals.
 * @returns {number|null} The rounded value.
 */
function rounded(value, decimals) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * @description Reachability of a device after a reading.
 * @param {object} previous - `{ failures, since, down, seen }` (or undefined).
 * @param {object} reading - `{ ok: boolean, now: number }`.
 * @returns {{ next: object, events: Array<{ key: string, data: object }> }} The new
 * state and the events (data without the device identity).
 */
function detectReachability(previous, reading) {
  const state = previous ?? { failures: 0, since: null, down: false, seen: false };
  const events = [];
  const next = { ...state };
  if (!reading.ok) {
    next.failures = (state.failures ?? 0) + 1;
    next.since ??= reading.now;
    if (
      !state.down &&
      state.seen &&
      next.failures >= UNREACHABLE_AFTER &&
      reading.now - next.since >= UNREACHABLE_MIN_MS
    ) {
      next.down = true;
      events.push({ key: TRIGGERS.UNREACHABLE, data: { failures: next.failures } });
    }
    return { next, events };
  }
  if (state.down) {
    events.push({
      key: TRIGGERS.BACK_ONLINE,
      data: {
        down_minutes: Math.max(0, Math.round((reading.now - (state.since ?? reading.now)) / 60000)),
      },
    });
  }
  next.failures = 0;
  next.since = null;
  next.down = false;
  next.seen = true;
  return { next, events };
}

/**
 * @description The alarm and warning transitions between two readings.
 * @param {object|null} before - The values before (null: first reading, nothing fires).
 * @param {object} after - The values now.
 * @returns {Array<{ key: string, data: object }>} The events (data: codes and keys only).
 */
function detectAlarms(before, after) {
  if (!before) return [];
  const events = [];
  if (after.alarmCode && after.alarmCode !== before.alarmCode) {
    const data = { code: after.alarmCode, alarm: after.alarm, leak: Boolean(after.leak) };
    if (after.leak) events.push({ key: TRIGGERS.LEAK, data });
    events.push({ key: TRIGGERS.ALARM, data });
  }
  if (!after.alarmCode && before.alarmCode) {
    events.push({
      key: TRIGGERS.ALARM_CLEARED,
      data: { code: before.alarmCode, alarm: before.alarm, leak: Boolean(before.leak) },
    });
  }
  if (after.warningCode && after.warningCode !== before.warningCode) {
    events.push({
      key: TRIGGERS.WARNING,
      data: { code: after.warningCode, warning: after.warning },
    });
  }
  return events;
}

export {
  TRIGGERS,
  SCENE_ACTIONS,
  OUTPUTS,
  UNREACHABLE_AFTER,
  UNREACHABLE_MIN_MS,
  pick,
  rounded,
  detectReachability,
  detectAlarms,
};
