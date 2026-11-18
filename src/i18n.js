import { english, vietnamese } from './messages.js';

const LANG_KEY = 'clearhour:language';
const supported = (value) => value === 'vi' || value === 'en';

function preferredLanguage() {
  const requested = new URLSearchParams(globalThis.location?.search).get('lang');
  if (supported(requested)) return requested;
  try {
    const stored = globalThis.localStorage?.getItem(LANG_KEY);
    if (supported(stored)) return stored;
  } catch { /* language still works through the URL */ }
  return 'vi';
}

export const language = preferredLanguage();
export const locale = language === 'en' ? 'en-GB' : 'vi-VN';

export function t(text, ...values) {
  const key = typeof text === 'string' ? text : text.map((part, i) => (i ? '{' + (i - 1) + '}' : '') + part).join('');
  const catalog = language === 'en' ? english : vietnamese;
  const message = Object.hasOwn(catalog, key) ? catalog[key] : key;
  return values.length ? message.replace(/\{(\d+)\}/g, (_, index) => String(values[index])) : message;
}

export function localized(vi, en) {
  return language === 'en' ? en : vi;
}

export function localizedHref(path) {
  const url = new URL(path, location.href);
  url.searchParams.set('lang', language);
  return url.href;
}

export function localizeShell() {
  document.documentElement.lang = language;
  const select = document.getElementById('language');
  select.value = language;
  select.addEventListener('change', () => {
    try { localStorage.setItem(LANG_KEY, select.value); } catch { /* URL is sufficient */ }
    const url = new URL(location.href);
    url.searchParams.set('lang', select.value);
    location.replace(url.href);
  });
  for (const link of document.querySelectorAll('[data-app-link]')) link.href = localizedHref(link.getAttribute('href'));

  if (language !== 'en') return;
  for (const node of document.querySelectorAll('[data-en]')) node.textContent = node.dataset.en;
  for (const node of document.querySelectorAll('[data-en-label]')) node.setAttribute('aria-label', node.dataset.enLabel);
  for (const node of document.querySelectorAll('meta[data-en-content]')) node.content = node.dataset.enContent;
  document.title = 'ClearHour · Find a better time to go outside';
}
