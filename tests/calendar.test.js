import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs, googleCalendarUrl, icsStamp, localToUtc } from '../src/calendar.js';

const ev = {
  uid: '2026-10-31T16:00-run@clearhour',
  title: '🏃 Chạy bộ – giờ ít bụi mịn',
  description: 'PM2.5 dự báo 15,1 µg/m³; mức Tốt.\nGợi ý từ ClearHour: https://btphuong3011.github.io/clearhour/ với một mô tả đủ dài để phải gấp dòng',
  location: 'Hà Nội',
  start: localToUtc('2026-10-31T16:00', 25200),
  end: localToUtc('2026-10-31T17:00', 25200),
  now: new Date(Date.UTC(2026, 9, 31, 8, 0)),
};

test('đổi giờ địa phương (UTC+7) sang UTC', () => {
  assert.equal(ev.start.toISOString(), '2026-10-31T09:00:00.000Z');
  assert.equal(localToUtc('2026-11-01T03:00', 25200).toISOString(), '2026-10-31T20:00:00.000Z');
  assert.equal(icsStamp(ev.start), '20261031T090000Z');
});

test('tệp .ics đúng định dạng: CRLF, thời gian UTC, ký tự đặc biệt được escape, có nhắc trước 15 phút', () => {
  const ics = buildIcs(ev);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(ics.includes('DTSTART:20261031T090000Z\r\n'));
  assert.ok(ics.includes('DTEND:20261031T100000Z\r\n'));
  assert.ok(ics.includes('TRIGGER:-PT15M'));
  const unfolded = ics.replace(/\r\n /g, '');
  assert.ok(unfolded.includes('DESCRIPTION:PM2.5 dự báo 15\\,1 µg/m³\\; mức Tốt.\\nGợi ý'));
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
});

test('link Google Lịch chứa khoảng thời gian UTC', () => {
  const url = new URL(googleCalendarUrl(ev));
  assert.equal(url.hostname, 'calendar.google.com');
  assert.equal(url.searchParams.get('dates'), '20261031T090000Z/20261031T100000Z');
  assert.equal(url.searchParams.get('text'), ev.title);
});
