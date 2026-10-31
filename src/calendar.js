// Xuất một khung giờ gợi ý thành sự kiện lịch: tệp .ics (iPhone, Outlook…) hoặc link Google Lịch.

/** "2026-10-31T16:00" giờ địa phương + độ lệch UTC (giây) -> Date (UTC). */
export function localToUtc(localTime, utcOffsetSeconds = 0) {
  const [d, t] = localTime.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [h, min] = t.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, day, h, min) - utcOffsetSeconds * 1000);
}

/** Date -> "20261031T090000Z" */
export function icsStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Gấp dòng dài hơn 75 octet theo RFC 5545. */
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = '';
  let curLen = 0;
  for (const ch of line) {
    const len = new TextEncoder().encode(ch).length;
    if (curLen + len > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      curLen = 0;
    }
    cur += ch;
    curLen += len;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/**
 * @param {{title, description, location, start: Date, end: Date, uid, remindMinutes?, now?: Date}} ev
 */
export function buildIcs(ev) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ClearHour//VI',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${ev.uid}`,
    `DTSTAMP:${icsStamp(ev.now ?? new Date())}`,
    `DTSTART:${icsStamp(ev.start)}`,
    `DTEND:${icsStamp(ev.end)}`,
    `SUMMARY:${escapeText(ev.title)}`,
    `DESCRIPTION:${escapeText(ev.description)}`,
    `LOCATION:${escapeText(ev.location)}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeText(ev.title)}`,
    `TRIGGER:-PT${ev.remindMinutes ?? 15}M`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function googleCalendarUrl(ev) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: ev.title,
    dates: `${icsStamp(ev.start)}/${icsStamp(ev.end)}`,
    details: ev.description,
    location: ev.location,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

export function downloadIcs(ev, filename) {
  const blob = new Blob([buildIcs(ev)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
