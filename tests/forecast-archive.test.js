import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureForecast } from '../scripts/capture-forecast.mjs';
import { CITIES } from '../src/cities.js';

const time = ['2026-11-22T13:00', '2026-11-22T14:00'];
const batch = (fields) => CITIES.map((_, location_id) => ({
  location_id,
  utc_offset_seconds: 25200,
  hourly: { time, ...Object.fromEntries(fields.map((field) => [field, [20, 30]])) },
}));
const air = () => batch(['pm2_5', 'pm10', 'ozone']);
const weather = () => batch(['precipitation_probability', 'precipitation', 'apparent_temperature', 'uv_index']);

test('snapshot records live input for each city with timestamps and code revision', async () => {
  const read = async (url) => url.includes('/air-quality?') ? air()
    : url.includes('/forecast?') ? weather() : { stations: [] };
  const result = await captureForecast({ read, revision: 'release-for-test' });
  assert.deepEqual(result.cities.map((city) => city.id), CITIES.map((city) => city.id));
  assert.match(result.capturedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(result.revision, 'release-for-test');
  assert.equal(result.sources.air.fetchedAt, result.capturedAt);
  assert.equal(result.sources.weather.data[11].location_id, 11);
  assert.deepEqual(result.sources.air.data[11].hourly.ozone, [20, 30]);
});

test('weather failure is recorded and preserves valid air data', async () => {
  const read = async (url) => {
    if (url.includes('/air-quality?')) return air();
    if (url.includes('/forecast?')) throw new Error('503');
    return { stations: [] };
  };
  const result = await captureForecast({ read });
  assert.equal(result.sources.air.data.length, CITIES.length);
  assert.equal(result.sources.weather.error, '503');
  assert.ok(result.sources.weather.fetchedAt);
});

test('rejects incomplete or reordered air responses rather than archiving another city', async () => {
  const malformed = air();
  [malformed[0], malformed[1]] = [malformed[1], malformed[0]];
  const read = async (url) => url.includes('/air-quality?') ? malformed
    : url.includes('/forecast?') ? weather() : { stations: [] };
  await assert.rejects(captureForecast({ read }), /Unexpected forecast location order/);
});
