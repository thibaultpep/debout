// Petits outils : DOM, dates et fuseaux horaires, formats.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
}

export function randomToken() {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const localTz = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Paris'; } catch { return 'Europe/Paris'; }
};

const dtfCache = new Map();
function dtf(tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return dtfCache.get(tz);
}

// Composantes de date dans un fuseau donné
export function tzParts(date, tz) {
  const p = {};
  for (const { type, value } of dtf(tz).formatToParts(date)) p[type] = value;
  const y = +p.year, m = +p.month, d = +p.day;
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7; // 1 = lundi … 7 = dimanche
  return { y, m, d, hh: +p.hour, mm: +p.minute, ss: +p.second, dow };
}

function tzOffsetMs(date, tz) {
  const p = tzParts(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// Heure murale (y, m, d, hh, mm) dans le fuseau tz -> instant réel
export function zonedToDate(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  let ts = guess - tzOffsetMs(new Date(guess), tz);
  ts = guess - tzOffsetMs(new Date(ts), tz);
  return new Date(ts);
}

export const ymd = (p) => `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;

// Prochaines sonneries d'un réveil récurrent, entre `from` et `from + horizonH`
export function occurrences(alarm, from = new Date(), horizonH = 36, pastMin = 0) {
  const tz = alarm.tz || 'Europe/Paris';
  const [hh, mm] = alarm.time.split(':').map(Number);
  const start = new Date(from.getTime() - pastMin * 60000);
  const end = new Date(from.getTime() + horizonH * 3600000);
  const out = [];
  const base = tzParts(new Date(start.getTime() - 86400000), tz);
  for (let i = 0; i < Math.ceil(horizonH / 24) + 3; i++) {
    const day = new Date(Date.UTC(base.y, base.m - 1, base.d + i));
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    const dow = day.getUTCDay() || 7;
    if (!alarm.days.includes(dow)) continue;
    const at = zonedToDate(y, m, d, hh, mm, tz);
    if (at >= start && at <= end) out.push({ at, day: ymd({ y, m, d }) });
  }
  return out;
}

const DAY_SHORT = ['', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];
export const DAY_LETTERS = ['', 'L', 'M', 'M', 'J', 'V', 'S', 'D'];
export const DAY_LONG = ['', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

export function hhmm(date) {
  return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// « aujourd'hui 07:30 », « demain 07:30 », « jeu. 07:30 »
export function relDay(date, now = new Date()) {
  const a = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((a - b) / 86400000);
  if (diff === 0) return "aujourd'hui";
  if (diff === 1) return 'demain';
  if (diff === -1) return 'hier';
  if (diff > 1 && diff < 7) return DAY_SHORT[date.getDay() || 7];
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

export const whenLabel = (date) => `${relDay(date)} ${hhmm(date)}`;

export function daysLabel(days) {
  const s = [...days].sort().join('');
  if (s === '1234567') return 'Tous les jours';
  if (s === '12345') return 'En semaine';
  if (s === '67') return 'Le week-end';
  return [...days].sort().map((d) => DAY_SHORT[d]).join(' ');
}

export function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  return d === 1 ? 'hier' : `il y a ${d} j`;
}

export function duration(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

export function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - y0) / 86400000 + 1) / 7);
}

export const store = {
  get(k, def = null) { try { const v = localStorage.getItem('debout.' + k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem('debout.' + k, JSON.stringify(v)); } catch { /* plein ou bloqué */ } },
  del(k) { try { localStorage.removeItem('debout.' + k); } catch { /* */ } },
};

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
