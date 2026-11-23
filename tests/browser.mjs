import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { addDays, formatClock } from '../src/time.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const scope = '/clearhour/';
const contents = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp',
};
let build = 'test-1';
let stations = [];
let disconnected = false;
let benchmark = null;
const benchmarkRow = {
  hours: 6, available: 25, scenarios: 27, meanLeadHours: 6.8,
  app: { better: 18, same: 1, worse: 1, scored: 20, switches: 22, days: 7, rate: null },
};
const generatedAt = new Date().toISOString();

const server = createServer(async (req, res) => {
  if (disconnected) {
    req.socket.destroy();
    return;
  }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = pathname.slice(scope.length) || 'index.html';
  const path = resolve(root, file);
  if (!pathname.startsWith(scope) || !path.startsWith(resolve(root) + sep)) {
    res.writeHead(404).end();
    return;
  }
  try {
    let body;
    if (file === 'data/accuracy.json' || file === 'data/stations.json') {
      body = JSON.stringify({ generatedAt, stations });
    } else if (file === 'data/decision-benchmark.json' && benchmark) {
      body = JSON.stringify(benchmark);
    } else if (file === 'sw.js') {
      body = (await readFile(path, 'utf8')).replace("const BUILD = 'dev'", "const BUILD = '" + build + "'");
    } else {
      body = await readFile(path);
    }
    res.writeHead(200, { 'Content-Type': contents[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const site = 'http://127.0.0.1:' + server.address().port + scope;

const date = '2026-11-23';
const hours = Array.from({ length: 72 }, (_, i) =>
  addDays(date, Math.floor(i / 24)) + 'T' + formatClock(i % 24),
);
const air = {
  latitude: 21, longitude: 106, timezone: 'Asia/Bangkok', utc_offset_seconds: 25200,
  current: { time: hours[6], pm2_5: 180, pm10: 195, ozone: 50 },
  hourly: { time: hours, pm2_5: hours.map((_, i) => i % 24 === 11 ? 160 : 180), pm10: hours.map(() => 195), ozone: hours.map(() => 50) },
};

async function mockForecast(context, rain) {
  await context.route('https://air-quality-api.open-meteo.com/**', (route) =>
    new URL(route.request().url()).searchParams.has('current')
      ? route.fulfill({ json: air }) : route.fulfill({ status: 503 }),
  );
  await context.route('https://api.open-meteo.com/**', (route) => route.fulfill({ json: {
    hourly: { time: hours, precipitation_probability: hours.map((_, i) => rain && i === 11 ? 95 : 0) },
  } }));
}

async function checkPlanner(browser) {
  const context = await browser.newContext({
    serviceWorkers: 'block', viewport: { width: 390, height: 820 }, hasTouch: true, isMobile: true,
  });
  await mockForecast(context, false);
  benchmark = {
    version: 1, minScored: 20, minDays: 7, from: '2026-11-14', through: '2026-11-22',
    station: { name: 'Reference station' }, rows: [benchmarkRow],
  };
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(site + '?city=hcm&lang=vi&free=7-15&scope=today');
  await page.locator('.required-trip').waitFor();
  assert.match(await page.locator('.required-trip').innerText(), /Nếu bắt buộc phải ra ngoài[\s\S]*11:00–12:00[\s\S]*Mức bụi vẫn cao[\s\S]*30 phút/);
  assert.equal(await page.locator('#intro-art').getAttribute('src'), 'assets/saigon-river-photo.webp');
  await page.locator('#intro-art').evaluate((photo) => photo.decode());
  assert.match(await page.locator('#intro-caption').innerText(), /Sông Sài Gòn/);
  assert.equal(await page.locator('#intro-author').innerText(), 'Gurval Le Bouter');
  assert.equal(await page.locator('#intro-license').getAttribute('href'), 'https://creativecommons.org/licenses/by/2.0/');
  assert.equal(await page.locator('#org-history').isVisible(), false);
  const audit = page.locator('#decision-benchmark');
  await audit.getByText(/20\/22 lần đổi có đủ số đo/).waitFor();
  assert.doesNotMatch(await audit.innerText(), /90%/);
  assert.equal(await page.locator('#chart-layer').isVisible(), false);
  await page.locator('#chart-scroll [data-hour="2026-11-23T11:00"]').tap();
  assert.match(await page.locator('#chart-hour').innerText(), /11:00[\s\S]*Bụi mịn cao/);
  await page.locator('#city').selectOption('danang');
  await page.waitForFunction(() => document.querySelector('#intro-art').src.endsWith('dragon-bridge-photo.webp'));
  await page.locator('#intro-art').evaluate((photo) => photo.decode());
  assert.equal(await page.locator('#intro-author').innerText(), 'Bùi Thụy Đào Nguyên');
  assert.equal(await page.locator('#intro-license').getAttribute('href'), 'https://creativecommons.org/licenses/by-sa/3.0/');
  await mockForecast(context, true);
  benchmarkRow.app.rate = 0.9;
  await page.locator('#language').selectOption('en');
  await audit.getByText(/18\/20 switches lowered PM2.5 \(90%\)/).waitFor();
  await page.getByText('Dragon Bridge, Da Nang', { exact: true }).waitFor();
  await page.locator('.required-trip').waitFor();
  const trip = page.locator('.required-trip');
  assert.match(await trip.innerText(), /If you have to go out[\s\S]*Check the warning for each time/);
  assert.doesNotMatch(await trip.innerText(), /lowest forecast PM2.5/);
  await trip.locator('summary').click();
  assert.match(await trip.locator('li').filter({ hasText: '11:00–12:00' }).innerText(), /Likely rain/i);
  await page.evaluate(() => { window.print = () => {}; });
  await page.getByRole('button', {name:'Print report'}).click();
  await page.emulateMedia({ media: 'print' });
  assert.match(await page.locator('#org-print-report').innerText(), /Outdoor activity report/);
  assert.doesNotMatch(await page.locator('#org-print-report').innerText(), /null|undefined|Modelled patterns/);
  assert.deepEqual(errors, []);
  await context.close();
}

async function checkPwa(browser) {
  stations = [{ id: 4946812 }];
  const context = await browser.newContext();
  await mockForecast(context, false);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(site + '?city=hanoi&lang=vi');
  await page.waitForFunction(() => navigator.serviceWorker.controller != null);
  assert.equal(await page.evaluate(async () => (
    await fetch('manifest.webmanifest').then((response) => response.json())
  ).display), 'standalone');
  await context.unrouteAll();
  await context.route('https://*.open-meteo.com/**', (route) => route.abort('internetdisconnected'));
  disconnected = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText(/Dữ liệu mẫu Hà Nội ngày/).waitFor();
  assert.equal(await page.locator('#intro-art').getAttribute('src'), 'assets/hoan-kiem-photo.webp');
  await page.locator('#intro-art').evaluate((photo) => photo.decode());
  assert.equal(await page.locator('#intro-author').innerText(), 'Bùi Thụy Đào Nguyên');
  assert.equal(await page.locator('#intro-license').getAttribute('href'), 'https://creativecommons.org/licenses/by-sa/4.0/');
  await page.getByText(/Bản lưu số đo trạm, cập nhật lúc/).waitFor();
  await page.getByText(/Bản lưu hệ số hiệu chỉnh, cập nhật lúc/).waitFor();
  assert.equal(await page.locator('#chart-layer').isVisible(), false);
  await page.evaluate(async () => {
    const cache = await caches.open('clearhour:/clearhour/:data:1');
    const old = { generatedAt: '2020-01-01T00:00:00Z', stations: [{ id: 4946812 }] };
    await Promise.all(['data/stations.json', 'data/accuracy.json'].map((path) =>
      cache.put(path, new Response(JSON.stringify(old))),
    ));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#chart-scroll svg').waitFor();
  assert.equal(await page.locator('#cached-stations').isVisible(), false);
  assert.equal(await page.locator('#cached-accuracy').isVisible(), false);

  disconnected = false;
  await context.unrouteAll();
  await mockForecast(context, false);
  build = 'test-2';
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  const update = page.getByRole('button', { name: 'Tải phiên bản mới' });
  await update.waitFor();
  await page.evaluate(() => { window.__beforeClearHourUpdate = true; });
  await update.click();
  await page.waitForFunction(async () => {
    const keys = await caches.keys();
    return !window.__beforeClearHourUpdate && keys.includes('clearhour:/clearhour/:shell:test-2') &&
      !keys.includes('clearhour:/clearhour/:shell:test-1');
  });
  assert.deepEqual(errors, []);
  await context.close();
}

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome' });
  await checkPlanner(browser);
  console.log('PASS VI/EN, missing historical and correction data, chart warnings, city art and print');
  await checkPwa(browser);
  console.log('PASS PWA offline, data age labels and service worker update');
} finally {
  await browser?.close();
  server.close();
}
