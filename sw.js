/* App-shell only. Never cache Google sign-in, tokens or Drive responses.
 * Bump VERSION whenever a shell asset changes. New workers wait until old
 * tabs close so a running tab never mixes app versions.
 */
const VERSION = 'bujo-shell-v3-journal-toggle';
const CACHE_PREFIX = `bujo-${self.registration.scope}-`;
const CACHE_NAME = CACHE_PREFIX + VERSION;
const SHELL = ['./', './index.html', './script.js', './style.css',
  './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];
const SHELL_URLS = new Set(SHELL.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const cleanURL = new URL(url);
  cleanURL.search = '';
  const isShellNavigation = event.request.mode === 'navigate' && SHELL_URLS.has(cleanURL.href);
  if (!SHELL_URLS.has(url.href) && !isShellNavigation) return;
  event.respondWith(caches.open(CACHE_NAME).then(async cache => {
    const cached = await cache.match(isShellNavigation ? new URL('./index.html', self.registration.scope).href : event.request);
    return cached || fetch(event.request);
  }));
});
