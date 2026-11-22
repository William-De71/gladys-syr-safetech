// -----------------------------------------------------------------------------
// Dashboard widgets of the SYR integration (pure builders: app.js gives them
// what it read).
//
//   - overview:    one device: the water flow now, the pressure, the
//                  temperature, today's water; the valve, the alarm, the
//                  profile, the battery; buttons to shut the water off or
//                  open it again, to clear the alarm and to start the
//                  microleak test;
//   - consumption: one device: a bar chart of the water used each of the last
//                  14 days (worked out from its total), today and the average.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS, WIDGET_BUTTON_STYLES } from '@gladysassistant/integration-sdk';
import { t, ago, formatNumber } from './i18n.js';
import { alarmText, warningText, profileName } from './device.js';

const WIDGETS = { OVERVIEW: 'overview', CONSUMPTION: 'consumption' };
const WIDGET_ACTIONS = {
  CLOSE_VALVE: 'close_valve',
  OPEN_VALVE: 'open_valve',
  RESET_ALARM: 'reset_alarm',
  MICROLEAK_TEST: 'microleak_test',
};
const TTL_SECONDS = { overview: 30, consumption: 600, message: 120 };
const CHART_DAYS = 14;

/**
 * @description Truncate a text to a bound, with an ellipsis.
 * @param {string} value - The text.
 * @param {number} max - The bound.
 * @returns {string} The text.
 */
function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * @description A widget content made of one message.
 * @param {string} message - The message.
 * @param {object} [options] - `{ heading, ttl }`.
 * @returns {object} The content.
 */
function messageContent(message, { heading, ttl = TTL_SECONDS.message } = {}) {
  const components = [];
  if (heading) {
    components.push({ type: 'text', variant: 'heading', text: clip(heading, 40) });
  }
  components.push({ type: 'text', variant: 'body', text: clip(message, 300) });
  return { ttl_seconds: ttl, components };
}

/**
 * @description A tile value.
 * @param {number|null} value - The value.
 * @param {string} unit - Its unit.
 * @param {string} language - The language.
 * @param {number} decimals - The decimals at most.
 * @returns {{ value: string, unit?: string }} The value and its unit.
 */
function tileValue(value, unit, language, decimals) {
  if (!Number.isFinite(value)) return { value: '–' };
  return { value: clip(formatNumber(value, language, decimals), 12), unit };
}

/**
 * @description The text and color of the valve.
 * @param {object} values - The device values.
 * @param {string} language - The language.
 * @returns {{ text: string, color: string }} The row.
 */
function valveRow(values, language) {
  const state =
    values.motorState ?? (values.closed ? 'closed' : values.closed === false ? 'open' : null);
  const text = state ? t(`valve_${state}`, language) : '–';
  const color =
    state === 'open'
      ? WIDGET_COLORS.SUCCESS
      : state === 'closed'
        ? WIDGET_COLORS.DANGER
        : state
          ? WIDGET_COLORS.WARNING
          : WIDGET_COLORS.NEUTRAL;
  return { text, color };
}

/**
 * @description The "overview" widget.
 * @param {object} options - Options.
 * @param {object} options.device - The stored device.
 * @param {string} options.name - Its name (the Gladys one when created).
 * @param {number|null} options.todayLiters - The water of today.
 * @param {string} options.language - The user language.
 * @param {number} options.now - Now (ms).
 * @returns {object} The content.
 */
function buildOverviewWidget({ device, name, todayLiters, language, now }) {
  const values = device.values ?? {};
  const down = Boolean(device.seen?.down);
  const components = [{ type: 'text', variant: 'heading', text: clip(name, 40) }];
  const neutralOr = (color) => (down ? WIDGET_COLORS.NEUTRAL : color);
  const flowing = (values.flowLh ?? 0) > 0;
  components.push({
    type: 'value',
    label: clip(t('tileFlow', language), 24),
    ...tileValue(Number.isFinite(values.flowLh) ? values.flowLh / 60 : null, 'L/min', language, 1),
    icon: 'droplet',
    color: neutralOr(flowing ? WIDGET_COLORS.PRIMARY : WIDGET_COLORS.NEUTRAL),
  });
  components.push({
    type: 'value',
    label: clip(t('tileToday', language), 24),
    ...tileValue(todayLiters, 'L', language, 0),
    icon: 'bar-chart-2',
    color: neutralOr(WIDGET_COLORS.INFO),
  });
  if (Number.isFinite(values.pressureBar)) {
    components.push({
      type: 'value',
      label: clip(t('tilePressure', language), 24),
      ...tileValue(values.pressureBar, 'bar', language, 1),
      icon: 'activity',
      color: neutralOr(WIDGET_COLORS.PRIMARY),
    });
  }
  const rows = [];
  if (down) {
    rows.push({
      label: clip(t('rowState', language), 40),
      value: clip(t('stateUnreachable', language), 40),
      color: WIDGET_COLORS.DANGER,
    });
  }
  const valve = valveRow(values, language);
  rows.push({
    label: clip(t('rowValve', language), 40),
    value: clip(valve.text, 40),
    color: neutralOr(valve.color),
  });
  const alarm = alarmText(values, language);
  rows.push({
    label: clip(t('rowAlarm', language), 40),
    value: clip(alarm || t('alarm_none', language), 40),
    color: neutralOr(alarm ? WIDGET_COLORS.DANGER : WIDGET_COLORS.SUCCESS),
  });
  const warning = warningText(values, language);
  if (warning) {
    rows.push({
      label: clip(t('rowWarning', language), 40),
      value: clip(warning, 40),
      color: neutralOr(WIDGET_COLORS.WARNING),
    });
  }
  if (Number.isFinite(values.temperatureC)) {
    rows.push({
      label: clip(t('rowTemperature', language), 40),
      value: `${formatNumber(values.temperatureC, language, 1)} °C`,
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  const profile = profileName(values);
  if (profile) {
    rows.push({
      label: clip(t('rowProfile', language), 40),
      value: clip(profile, 40),
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  if (Number.isFinite(values.batteryPercent) || values.batteryLow) {
    rows.push({
      label: clip(t('rowBattery', language), 40),
      value: clip(
        Number.isFinite(values.batteryPercent)
          ? `${values.batteryPercent} %`
          : t('batteryLow', language),
        40,
      ),
      color: neutralOr(values.batteryLow ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL),
    });
  }
  if (values.microleakTest) {
    rows.push({
      label: clip(t('rowTest', language), 40),
      value: clip(t('testRunning', language), 40),
      color: neutralOr(WIDGET_COLORS.INFO),
    });
  }
  rows.push({
    label: clip(t('rowLastReading', language), 40),
    value: clip(ago(device.readAt ?? 0, now, language), 40),
    color: down ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
  });
  components.push({ type: 'status', items: rows });
  if (!down) {
    const params = { device: device.id };
    if (values.valveFormat && typeof values.closed === 'boolean') {
      components.push(
        values.closed
          ? {
              type: 'button',
              label: clip(t('buttonOpen', language), 24),
              icon: 'unlock',
              style: WIDGET_BUTTON_STYLES.PRIMARY,
              action: { key: WIDGET_ACTIONS.OPEN_VALVE, params, confirm: true },
            }
          : {
              type: 'button',
              label: clip(t('buttonClose', language), 24),
              icon: 'lock',
              style: WIDGET_BUTTON_STYLES.DANGER,
              action: { key: WIDGET_ACTIONS.CLOSE_VALVE, params, confirm: true },
            },
      );
    }
    if (values.alarmCode) {
      components.push({
        type: 'button',
        label: clip(t('buttonReset', language), 24),
        icon: 'bell-off',
        style: WIDGET_BUTTON_STYLES.SECONDARY,
        action: { key: WIDGET_ACTIONS.RESET_ALARM, params },
      });
    }
    if (!values.microleakTest && !values.closed) {
      components.push({
        type: 'button',
        label: clip(t('buttonTest', language), 24),
        icon: 'search',
        style: WIDGET_BUTTON_STYLES.SECONDARY,
        action: { key: WIDGET_ACTIONS.MICROLEAK_TEST, params, confirm: true },
      });
    }
  }
  return { ttl_seconds: TTL_SECONDS.overview, components };
}

/**
 * @description The "consumption" widget: the water of the last 14 days.
 * @param {object} options - Options.
 * @param {object} options.device - The stored device.
 * @param {string} options.name - Its name.
 * @param {Array<{ day: string, liters: number|null }>} options.days - The last days, oldest first, today last.
 * @param {string} options.language - The user language.
 * @returns {object} The content.
 */
function buildConsumptionWidget({ device, name, days, language }) {
  const down = Boolean(device.seen?.down);
  const components = [{ type: 'text', variant: 'heading', text: clip(name, 40) }];
  const today = days.at(-1)?.liters ?? null;
  const past = days.slice(0, -1).filter((entry) => Number.isFinite(entry.liters));
  const average = past.length
    ? past.reduce((sum, entry) => sum + entry.liters, 0) / past.length
    : null;
  components.push({
    type: 'value',
    label: clip(t('tileToday', language), 24),
    ...tileValue(today, 'L', language, 0),
    icon: 'droplet',
    color: down ? WIDGET_COLORS.NEUTRAL : WIDGET_COLORS.PRIMARY,
  });
  components.push({
    type: 'value',
    label: clip(t('tileAverage', language), 24),
    ...tileValue(average, 'L', language, 0),
    icon: 'bar-chart-2',
    color: WIDGET_COLORS.INFO,
  });
  const values = device.values ?? {};
  components.push({
    type: 'value',
    label: clip(t('tileMeter', language), 24),
    ...tileValue(Number.isFinite(values.totalL) ? values.totalL / 1000 : null, 'm³', language, 1),
    icon: 'hash',
    color: WIDGET_COLORS.NEUTRAL,
  });
  const known = days.filter((entry) => Number.isFinite(entry.liters));
  if (known.length >= 2) {
    components.push({
      type: 'chart',
      chart_type: 'bar',
      title: clip(t('chartDays', language, { n: CHART_DAYS }), 60),
      unit: 'L',
      series: [
        {
          name: clip(t('seriesWater', language), 40),
          points: known.map((entry) => ({
            t: `${entry.day}T12:00:00.000Z`,
            v: Math.round(entry.liters),
          })),
        },
      ],
    });
  } else {
    components.push({
      type: 'text',
      variant: 'caption',
      text: clip(t('widgetNoHistory', language), 80),
    });
  }
  return { ttl_seconds: TTL_SECONDS.consumption, components };
}

export {
  WIDGETS,
  WIDGET_ACTIONS,
  TTL_SECONDS,
  CHART_DAYS,
  clip,
  messageContent,
  tileValue,
  valveRow,
  buildOverviewWidget,
  buildConsumptionWidget,
};
