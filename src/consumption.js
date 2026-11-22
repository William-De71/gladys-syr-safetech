// -----------------------------------------------------------------------------
// Water used per day, from the total volume of a device (getVOL, liters).
//
// The devices only report a running total. The integration notes the total at
// the first reading of each day (in the timezone of Gladys): the water of a
// day is the next day's first total minus its own. A total lower than before
// (meter reset, device swapped) starts the counting again from it.
// 35 days are kept: the chart shows 14, the scene action today and yesterday.
// -----------------------------------------------------------------------------

const KEEP_DAYS = 35;

/**
 * @description The day of an instant in a timezone.
 * @param {number} at - The instant (ms).
 * @param {string} timeZone - IANA timezone.
 * @returns {string} "2026-11-22".
 */
function dayOf(at, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * @description The day before or after a day.
 * @param {string} day - "2026-11-22".
 * @param {number} offset - Days to add (negative: before).
 * @returns {string} The day.
 */
function shiftDay(day, offset) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/**
 * @description Note a total volume: the first total of each day.
 * @param {object} usage - The stored usage (`{ days: { day: liters }, last }`), changed in place.
 * @param {number|null} totalL - The total now.
 * @param {number} at - Now (ms).
 * @param {string} timeZone - IANA timezone.
 * @returns {object} The usage.
 */
function noteTotal(usage, totalL, at, timeZone) {
  usage.days ??= {};
  if (!Number.isFinite(totalL) || totalL < 0) return usage;
  const today = dayOf(at, timeZone);
  if (Number.isFinite(usage.last) && totalL < usage.last) {
    // Reset or another device: the past days cannot be compared to it any more.
    usage.days = {};
  }
  usage.days[today] ??= totalL;
  usage.last = totalL;
  const days = Object.keys(usage.days).sort();
  for (const day of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) {
    delete usage.days[day];
  }
  return usage;
}

/**
 * @description The water of a day, in liters.
 * @param {object} usage - The stored usage.
 * @param {string} day - The day.
 * @param {string} today - Today.
 * @returns {number|null} Liters, null when unknown.
 */
function litersOf(usage, day, today) {
  const start = usage?.days?.[day];
  if (!Number.isFinite(start)) return null;
  const end = day === today ? usage.last : usage.days[shiftDay(day, 1)];
  return Number.isFinite(end) ? Math.max(0, end - start) : null;
}

/**
 * @description The water of the last days, oldest first.
 * @param {object} usage - The stored usage.
 * @param {number} count - How many days, today included.
 * @param {number} at - Now (ms).
 * @param {string} timeZone - IANA timezone.
 * @returns {Array<{ day: string, liters: number|null }>} The days.
 */
function lastDays(usage, count, at, timeZone) {
  const today = dayOf(at, timeZone);
  const days = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const day = shiftDay(today, -offset);
    days.push({ day, liters: litersOf(usage, day, today) });
  }
  return days;
}

export { KEEP_DAYS, dayOf, shiftDay, noteTotal, litersOf, lastDays };
