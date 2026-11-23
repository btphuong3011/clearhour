// Phiên bản của vỏ app được gắn theo commit khi triển khai GitHub Pages.
const BUILD = 'dev';
const base = new URL(self.registration.scope);
const prefix = 'clearhour:' + base.pathname + ':';
const shellCache = prefix + 'shell:' + BUILD;
const dataCache = prefix + 'data:1';
const dataAges = new Map([
  ['data/stations.json', 12 * 3600_000],
  ['data/accuracy.json', 48 * 3600_000],
]);
const shellFiles = [
  'index.html', 'manifest.webmanifest',
  'assets/styles.css', 'assets/favicon.svg', 'assets/icon-192.png', 'assets/icon-512.png',
  'assets/hoan-kiem-photo.webp', 'assets/saigon-river-photo.webp', 'assets/dragon-bridge-photo.webp', 'assets/hanoi-run.webp', 'assets/hanoi-window.webp', 'assets/school-courtyard.webp',
  'assets/fonts/lexend-vi.woff2', 'assets/fonts/lexend-latin.woff2',
  'assets/fonts/source-sans-3-vi.woff2', 'assets/fonts/source-sans-3-latin.woff2',
  'data/sample-hanoi.json',
  'src/accuracy.js', 'src/api.js', 'src/app.js', 'src/aqi.js', 'src/calendar.js', 'src/chart.js',
  'src/cities.js', 'src/conditions.js', 'src/decision-benchmark.js', 'src/format.js', 'src/history.js',
  'src/i18n.js', 'src/messages.js', 'src/planner.js', 'src/pwa.js', 'src/scene.js', 'src/stations.js', 'src/story.js', 'src/time.js',
];
const at = (path) => new URL(path, base).href;

async function latestData(path) {
  const cache = await caches.open(dataCache);
  const url = at(path);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(4500) });
    if (!response.ok) throw new Error('Data unavailable');
    try {
      const doc = await response.clone().json();
      if (doc.stations?.length && Number.isFinite(Date.parse(doc.generatedAt))) {
        await cache.put(url, response.clone());
      }
    } catch { /* Lỗi ghi cache không ảnh hưởng đến bản tải được qua mạng. */ }
    return response;
  } catch {
    const saved = await cache.match(url);
    if (saved) {
      const doc = await saved.clone().json();
      const age = Date.now() - Date.parse(doc.generatedAt);
      if (age >= 0 && age <= dataAges.get(path)) {
        return new Response(saved.body, {
          headers: {
            'Content-Type': 'application/json',
            'X-ClearHour-Cached': doc.generatedAt,
          },
        });
      }
    }
    return Response.error();
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(shellCache);
    await cache.addAll(shellFiles.map((path) => new Request(at(path), { cache: 'reload' })));
    await Promise.allSettled([...dataAges.keys()].map(latestData));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(prefix) && key !== shellCache && key !== dataCache)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'activate-update') event.waitUntil(self.skipWaiting());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return;
  const path = url.pathname.slice(base.pathname.length);
  if (dataAges.has(path)) {
    event.respondWith(latestData(path));
  } else if (event.request.mode === 'navigate' && (path === '' || path === 'index.html')) {
    event.respondWith(caches.match(at('index.html'), { cacheName: shellCache }).then((cached) => cached ?? fetch(event.request)));
  } else if (shellFiles.includes(path)) {
    event.respondWith(caches.match(at(path), { cacheName: shellCache }).then((cached) => cached ?? fetch(event.request)));
  }
});
