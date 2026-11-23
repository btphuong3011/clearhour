import { t, locale } from './i18n.js';

export function initPwa() {
  const install = document.getElementById('install-app');
  const update = document.getElementById('update-app');
  let promptEvent;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    promptEvent = event;
    install.hidden = false;
  });
  install.addEventListener('click', async () => {
    if (!promptEvent) return;
    const event = promptEvent;
    promptEvent = null;
    install.hidden = true;
    try { await event.prompt(); } catch { /* Trình duyệt quyết định khi nào có thể cài. */ }
  });
  window.addEventListener('appinstalled', () => { install.hidden = true; });

  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((registration) => {
    const showUpdate = () => { update.hidden = !registration.waiting || !navigator.serviceWorker.controller; };
    showUpdate();
    registration.addEventListener('updatefound', () => {
      registration.installing?.addEventListener('statechange', showUpdate);
    });
    update.addEventListener('click', () => {
      const next = registration.waiting;
      if (!next) return;
      update.disabled = true;
      let reloading = false;
      const reload = () => {
        if (!reloading && next.state === 'activated') {
          reloading = true;
          location.reload();
        }
        if (next.state === 'redundant') {
          update.disabled = false;
          showUpdate();
        }
      };
      next.addEventListener('statechange', reload);
      navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
      next.postMessage('activate-update');
    });
  }).catch(() => { /* App vẫn chạy trong trình duyệt. */ });
}

const formatter = new Intl.DateTimeFormat(locale, {
  dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh',
});

export function showCachedDataNotice(id, timestamp) {
  const date = new Date(timestamp);
  if (!timestamp || !Number.isFinite(+date)) return;
  const notice = document.getElementById(id);
  notice.hidden = false;
  notice.textContent = id === 'cached-stations'
    ? t`Bản lưu số đo trạm, cập nhật lúc ${formatter.format(date)} (giờ Việt Nam).`
    : t`Bản lưu hệ số hiệu chỉnh, cập nhật lúc ${formatter.format(date)} (giờ Việt Nam).`;
}
