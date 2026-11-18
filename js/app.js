// Debout ! — l'appli
import { CONFIG } from './config.js';
import { api, token } from './api.js';
import {
  h, $, toast, randomToken, localTz, occurrences, whenLabel, hhmm, DAY_LETTERS, DAY_LONG,
  ago, duration, store, isIOS, isStandalone,
} from './util.js';
import {
  SOUNDS, soundById, CHALLENGES, challengeById, weeklySurprise, AVATARS,
} from './data.js';
import {
  unlockAudio, isAudioUnlocked, previewSound, stopPreview, canRecord, startRecording, MAX_VOICE_S,
  keepScreenOn, releaseScreen, keepAlive, stopRinging, preloadSounds,
} from './audio.js';
import { showRing, isRinging } from './ring.js';

const S = {
  state: null,
  feed: null,
  tab: store.get('tab', 'potes'),
  schedule: [],
  voices: new Map(),
  sleeping: false,
  installEvt: null,
  sheetOpen: 0,
  pendingRender: false,
};
const app = $('#app');

// ============================================================================
// Démarrage

boot();

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'ring' && e.data.key) handleRingParam(e.data.key);
    });
  }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; });
  // premier tap : on « débloque » le son pour pouvoir sonner plus tard
  document.addEventListener('pointerdown', () => unlockAudio(), { once: true, capture: true });

  const params = new URLSearchParams(location.search);
  const invite = params.get('bande');
  if (invite) store.set('invite', invite.toUpperCase());

  if (!token()) { renderOnboarding(); return; }
  await startSession();
}

async function startSession() {
  app.replaceChildren(h('div', { class: 'loading' }, h('span', { class: 'logo-sun' }, '☀️')));
  try {
    await refresh(true);
  } catch (e) {
    if (e.code === 'AUTH') { store.del('token'); renderOnboarding(); return; }
    app.replaceChildren(h('div', { class: 'empty-page' },
      h('h1', {}, 'Debout !'), h('p', {}, e.message),
      h('button', { class: 'btn btn-main', onclick: () => startSession() }, 'Réessayer')));
    return;
  }
  const invite = store.get('invite');
  if (invite) {
    store.del('invite');
    try {
      const b = await api.joinBand(invite);
      toast(`Bienvenue dans « ${b.name} » 🎉`);
      S.tab = 'potes';
      await refresh();
    } catch (e) { toast(e.message, 'err'); }
  }
  const params = new URLSearchParams(location.search);
  if (params.has('bande') || params.has('ring')) {
    const ringKey = params.get('ring');
    history.replaceState(null, '', location.pathname);
    if (ringKey) handleRingParam(ringKey);
  }
  setInterval(tick, 1000);
  setInterval(() => { S.schedule = buildSchedule(); }, 60000);
  setInterval(() => { if (document.visibilityState === 'visible' || S.sleeping) refresh().catch(() => {}); }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refresh().catch(() => {});
      if (S.sleeping) keepScreenOn();
    }
  });
  resyncPush();
}

async function refresh(first = false) {
  const st = await api.state();
  S.state = st;
  S.schedule = buildSchedule();
  prefetchVoices();
  if (S.tab === 'fil' || first) loadFeed();
  render();
  if (S.sleeping) { renderSleep(); preloadSounds(['classique', ...nextOccs().slice(0, 4).map((o) => o.sound)]); }
}

async function loadFeed() {
  try { S.feed = await api.feed(); if (S.tab === 'fil') render(); } catch { /* hors ligne */ }
}

// ============================================================================
// Planning des sonneries

function buildSchedule(now = new Date(), pastMin = 15) {
  const st = S.state;
  if (!st) return [];
  const occs = [];
  for (const a of st.alarms.filter((x) => x.enabled)) {
    for (const o of occurrences(a, now, 40, pastMin)) {
      const traps = st.incoming.filter((w) => w.kind === 'trap' && w.alarm_id === a.id && Math.abs(new Date(w.fire_at) - o.at) < 60000);
      occs.push(makeOcc({ key: `a:${a.id}:${o.day}`, fireAt: o.at, alarm: a, wakeups: traps, kind: 'alarm' }));
    }
  }
  for (const w of st.incoming.filter((x) => x.kind === 'surprise')) {
    occs.push(makeOcc({ key: `w:${w.id}`, fireAt: new Date(w.fire_at), wakeups: [w], kind: 'surprise' }));
  }
  for (const sn of store.get('snoozes', [])) {
    occs.push({ ...sn.occ, key: sn.key, fireAt: new Date(sn.fireAt), kind: 'snooze', snoozes: sn.snoozes, firstRingAt: sn.firstRingAt });
  }
  return occs.sort((a, b) => a.fireAt - b.fireAt);
}

function makeOcc({ key, fireAt, alarm, wakeups, kind }) {
  const last = wakeups[wakeups.length - 1];
  const chal = wakeups.find((w) => w.challenge && w.challenge !== 'none');
  return {
    key, fireAt, kind,
    alarmId: alarm?.id || null,
    label: alarm?.label || '',
    sound: last?.sound || alarm?.sound || 'classique',
    challenge: chal?.challenge || alarm?.challenge || 'none',
    wakeups,
    voiceIds: wakeups.filter((w) => w.has_voice).map((w) => w.id),
  };
}

const nextOccs = () => S.schedule.filter((o) => o.fireAt > new Date() && o.kind !== 'snooze');

function fired() {
  const f = store.get('fired', {});
  const lim = Date.now() - 3 * 86400000;
  for (const k of Object.keys(f)) if (f[k] < lim) delete f[k];
  return f;
}
function markFired(key) { const f = fired(); f[key] = Date.now(); store.set('fired', f); }

function tick() {
  if (isRinging()) return;
  const now = Date.now();
  const f = fired();
  for (const occ of S.schedule) {
    const t = occ.fireAt.getTime();
    if (t <= now && now - t < 10 * 60000 && !f[occ.key]) {
      markFired(occ.key);
      ring(occ);
      return;
    }
  }
  if (S.sleeping) updateSleepClock();
}

async function prefetchVoices() {
  const soon = Date.now() + 16 * 3600000;
  const ids = S.schedule.filter((o) => o.fireAt.getTime() < soon).flatMap((o) => o.voiceIds || []);
  for (const id of ids) {
    if (S.voices.has(id)) continue;
    try { const v = await api.voice(id); if (v) S.voices.set(id, v); } catch { /* réessai au prochain tour */ }
  }
}

async function loadVoices(ids = [], timeoutMs = 2500) {
  const missing = ids.filter((id) => !S.voices.has(id));
  if (missing.length) {
    await Promise.race([
      Promise.all(missing.map((id) => api.voice(id).then((v) => v && S.voices.set(id, v)).catch(() => {}))),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
  }
  return ids.map((id) => S.voices.get(id)).filter(Boolean);
}

async function ring(occ, { needsTap = false } = {}) {
  let wokeUp = false;
  const voices = await loadVoices(occ.voiceIds);
  if (occ.kind === 'snooze') {
    store.set('snoozes', store.get('snoozes', []).filter((s) => s.key !== occ.key));
  }
  showRing({ ...occ, voices }, {
    needsTap: needsTap || !isAudioUnlocked(),
    snoozes: occ.snoozes || 0,
    firstRingAt: occ.firstRingAt,
    sleepMode: S.sleeping,
    onSnooze: async (o, { snoozes, firstRingAt }) => {
      let key, fireAt;
      try {
        const r = await api.reportRing({
          wakeupIds: o.wakeups.map((w) => w.id), alarmId: o.alarmId, action: 'snooze',
          snoozes, fireAt: o.fireAt.toISOString(), snoozeMinutes: 5,
        });
        key = `w:${r.snooze_id}`; fireAt = r.fire_at;
      } catch {
        key = `ls:${Date.now()}`; fireAt = new Date(Date.now() + 5 * 60000).toISOString();
      }
      const keep = { ...o, voices: undefined, fireAt: undefined };
      store.set('snoozes', [...store.get('snoozes', []), { key, fireAt, snoozes, firstRingAt, occ: keep }]);
      S.schedule = buildSchedule();
      toast('Snooze : ça resonne dans 5 minutes');
    },
    onStop: async (o, { seconds, snoozes }) => {
      store.set('snoozes', []);
      wokeUp = true;
      if (o.kind === 'test') return { senders: [] };
      const ids = [...new Set([...o.wakeups.map((w) => w.id), ...(o.originIds || [])])];
      return api.reportRing({
        wakeupIds: ids, alarmId: o.alarmId, action: 'stop', seconds: Math.round(seconds), snoozes,
        fireAt: (o.fireAt || new Date()).toISOString(),
      });
    },
    onReact: (id, em) => api.react(id, em).catch(() => {}),
    onClose: () => {
      S.schedule = buildSchedule();
      // réveillé pour de bon : on sort du mode dodo
      if (S.sleeping && wokeUp) exitSleep();
      else if (S.sleeping) renderSleep();
      refresh().catch(() => {});
    },
  });
}

// ouverture depuis une notification : ./?ring=a:<id>:<date> ou ./?ring=w:<id>
function handleRingParam(key) {
  if (isRinging()) return;
  if (fired()[key]) return;
  const occ = buildSchedule(new Date(), 30).find((o) => o.key === key);
  if (occ) {
    if (Date.now() - occ.fireAt.getTime() > 30 * 60000) return;
    markFired(key);
    ring(occ, { needsTap: true });
    return;
  }
  // fin de snooze reçue sans contexte local (autre téléphone, appli fermée)
  const w = S.state?.incoming.find((x) => `w:${x.id}` === key);
  if (w && w.message === 'test') { markFired(key); toast('Les notifications marchent 🎉'); return; }
  if (w) {
    markFired(key);
    ring(makeOcc({ key, fireAt: new Date(w.fire_at), wakeups: w.kind === 'snooze' ? [] : [w], kind: w.kind }), { needsTap: true });
  }
}

// ============================================================================
// Onboarding

function renderOnboarding() {
  let emoji = AVATARS[Math.floor(Math.random() * AVATARS.length)];
  const invite = store.get('invite');
  const pseudo = h('input', { class: 'field', maxlength: 24, placeholder: 'Ton surnom', autocomplete: 'nickname', 'aria-label': 'Ton surnom' });
  const pass = h('input', { class: 'field', type: 'password', placeholder: 'Mot de passe d\'accès', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Mot de passe d\'accès' });
  const grid = h('div', { class: 'avatars' }, AVATARS.map((a) => h('button', {
    type: 'button', class: `avatar-pick${a === emoji ? ' on' : ''}`, 'aria-label': `Avatar ${a}`,
    onclick: (e) => { emoji = a; grid.querySelectorAll('.on').forEach((x) => x.classList.remove('on')); e.currentTarget.classList.add('on'); },
  }, a)));
  const go = h('button', { class: 'btn btn-main btn-block' }, "C'est parti");
  const form = h('form', {
    class: 'onb-form',
    onsubmit: async (e) => {
      e.preventDefault();
      const p = pseudo.value.trim();
      if (!p) { pseudo.focus(); toast('Choisis un surnom pour que tes potes te reconnaissent', 'err'); return; }
      if (!pass.value.trim()) { pass.focus(); toast('Il faut le mot de passe d\'accès. Demande-le au pote qui t\'a invité.', 'err'); return; }
      go.disabled = true;
      const tok = randomToken();
      try {
        await api.register(tok, p, emoji, pass.value.trim());
        store.set('token', tok);
        S.tab = 'potes';
        await startSession();
      } catch (err) { toast(err.message, 'err'); go.disabled = false; }
    },
  }, h('label', { class: 'lbl' }, 'Comment tes potes t\'appellent ?'), pseudo,
  h('label', { class: 'lbl' }, 'Ta tête au réveil'), grid,
  h('label', { class: 'lbl' }, 'Mot de passe d\'accès'), pass,
  h('p', { class: 'hint' }, 'Debout ! est réservé à notre bande. Le pote qui t\'a invité te donne le mot de passe.'),
  go);

  app.replaceChildren(h('main', { class: 'onb' },
    h('div', { class: 'onb-hero' },
      h('h1', { class: 'wordmark' }, 'Debout !'),
      h('p', { class: 'onb-sub' }, 'Le réveil entre potes. Ce sont eux qui choisissent avec quoi tu te lèves.')),
    invite ? h('p', { class: 'invite-note' }, `🎉 Tu es invité dans une bande (code ${invite}). Crée ton profil pour la rejoindre.`) : null,
    form,
    h('button', { class: 'link', onclick: renderRestore }, "J'ai déjà un compte sur un autre téléphone"),
  ));
}

function renderRestore() {
  const input = h('input', { class: 'field mono', placeholder: 'Code de récupération', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Code de récupération' });
  app.replaceChildren(h('main', { class: 'onb' },
    h('h1', { class: 'wordmark small' }, 'Debout !'),
    h('p', {}, 'Sur ton ancien téléphone, va dans l\'onglet Moi et copie ton code de récupération. Colle-le ici.'),
    h('form', {
      class: 'onb-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const tok = input.value.replace(/[^0-9a-f]/gi, '').toLowerCase();
        try {
          await api.whoami(tok);
          store.set('token', tok);
          await startSession();
        } catch { toast('Ce code ne correspond à aucun compte', 'err'); }
      },
    }, input, h('button', { class: 'btn btn-main btn-block' }, 'Récupérer mon compte')),
    h('button', { class: 'link', onclick: renderOnboarding }, 'Retour'),
  ));
}

// ============================================================================
// Rendu principal

const TABS = [
  { id: 'potes', label: 'Potes', icon: '👥' },
  { id: 'reveils', label: 'Réveils', icon: '⏰' },
  { id: 'fil', label: 'Le fil', icon: '📣' },
  { id: 'moi', label: 'Moi', icon: '🙂' },
];

function render() {
  if (!S.state) return;
  const active = document.activeElement;
  if (S.sheetOpen || (active && app.contains(active) && /INPUT|TEXTAREA|SELECT/.test(active.tagName))) {
    S.pendingRender = true;
    return;
  }
  S.pendingRender = false;
  const y = window.scrollY;
  const view = { potes: viewPotes, reveils: viewReveils, fil: viewFil, moi: viewMoi }[S.tab] || viewPotes;
  app.replaceChildren(
    h('header', { class: 'top' },
      h('h1', { class: 'top-title' }, { potes: 'Mes potes', reveils: 'Mes réveils', fil: 'Le fil', moi: 'Moi' }[S.tab]),
      h('button', { class: 'moon', onclick: enterSleep, 'aria-label': 'Passer en mode dodo' }, '🌙')),
    h('main', { class: 'page' }, view()),
    h('nav', { class: 'tabs', 'aria-label': 'Navigation' }, TABS.map((t) => h('button', {
      class: `tab${S.tab === t.id ? ' on' : ''}`, 'aria-current': S.tab === t.id ? 'page' : false,
      onclick: () => {
        if (S.tab === t.id) return;
        S.tab = t.id; store.set('tab', t.id);
        if (t.id === 'fil') loadFeed();
        render(); window.scrollTo(0, 0);
      },
    }, h('span', { class: 'tab-ic' }, t.icon), h('span', {}, t.label)))),
  );
  window.scrollTo(0, y);
}

// ---------------------------------------------------------------------------
// Onglet Potes

function viewPotes() {
  const st = S.state;
  const wk = weeklySurprise();
  const out = [
    h('section', { class: 'weekly' },
      h('span', { class: 'weekly-emoji', 'aria-hidden': 'true' }, wk.emoji),
      h('div', {},
        h('p', { class: 'weekly-k' }, 'Surprise de la semaine'),
        h('p', { class: 'weekly-name' }, wk.name),
        h('p', { class: 'weekly-pitch' }, wk.pitch))),
  ];
  if (!st.bands.length) {
    out.push(h('section', { class: 'empty' },
      h('h2', {}, 'Monte ta bande'),
      h('p', {}, 'Une bande, c\'est ton groupe de potes : tout le monde peut piéger le réveil de tout le monde. Crée la tienne et envoie le lien, ou rejoins celle d\'un pote avec son code.'),
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn btn-main', onclick: sheetCreateBand }, 'Créer une bande'),
        h('button', { class: 'btn', onclick: sheetJoinBand }, 'J\'ai un code'))));
    return out;
  }
  for (const b of st.bands) {
    out.push(h('section', { class: 'band' },
      h('div', { class: 'band-head' },
        h('h2', {}, b.name),
        h('div', { class: 'band-btns' },
          b.owner_id === st.me.id ? h('button', { class: 'btn btn-small', onclick: () => sheetManage(b) }, 'Gérer') : null,
          h('button', { class: 'btn btn-small', onclick: () => sheetInvite(b) }, 'Inviter'))),
      b.members.length === 1 ? h('p', { class: 'hint' }, 'Tu es seul ici pour l\'instant. Invite tes potes avec le bouton au-dessus.') : null,
      h('ul', { class: 'members' }, b.members.map((m) => memberRow(m)))));
  }
  out.push(h('div', { class: 'row-btns center' },
    h('button', { class: 'btn btn-small', onclick: sheetCreateBand }, 'Nouvelle bande'),
    h('button', { class: 'btn btn-small', onclick: sheetJoinBand }, 'Rejoindre une bande')));
  return out;
}

function memberNext(m) {
  const occ = m.alarms.flatMap((a) => occurrences(a, new Date(), 24 * 7).map((o) => ({ ...o, alarm: a })))
    .sort((a, b) => a.at - b.at);
  return occ;
}

function memberRow(m) {
  const me = m.id === S.state.me.id;
  const next = me ? [] : memberNext(m);
  const myTraps = S.state.outgoing.filter((w) => w.target.id === m.id);
  let sub;
  if (me) sub = 'C\'est toi';
  else if (next.length) sub = `Prochain réveil : ${whenLabel(next[0].at)}`;
  else sub = 'Aucun réveil programmé';
  return h('li', { class: 'member' },
    h('span', { class: 'av', 'aria-hidden': 'true' }, m.emoji),
    h('div', { class: 'member-txt' },
      h('p', { class: 'member-name' }, m.pseudo),
      h('p', { class: 'member-sub' }, sub),
      myTraps.length ? h('p', { class: 'member-trap' }, myTraps.map((w) =>
        `${w.kind === 'trap' ? '😈 Piège' : '📣 Surprise'} prévu ${whenLabel(new Date(w.fire_at))}`).join(' · ')) : null),
    me ? null : h('button', { class: 'btn btn-prank btn-small', onclick: () => sheetCompose(m) }, 'Le réveiller'));
}

// ---------------------------------------------------------------------------
// Onglet Réveils

function viewReveils() {
  const st = S.state;
  const nxt = nextOccs()[0];
  const out = [];
  out.push(h('section', { class: 'sleep-card' },
    h('div', {},
      h('h2', {}, 'Mode dodo'),
      h('p', {}, 'Le soir, lance-le et laisse ton téléphone allumé sur le chargeur : tu es sûr que ça sonne fort, avec les vocaux de tes potes.')),
    h('button', { class: 'btn btn-night', onclick: enterSleep }, '🌙 Lancer le mode dodo')));

  if (nxt) {
    const traps = nxt.wakeups.filter((w) => w.kind === 'trap').length;
    out.push(h('p', { class: 'next' },
      'Prochaine sonnerie : ', h('strong', {}, whenLabel(nxt.fireAt)),
      nxt.kind === 'surprise' ? ' (réveil surprise d\'un pote 📣)' : '',
      traps ? h('span', { class: 'teaser' }, ` 🤫 ${traps > 1 ? `${traps} potes ont` : 'un pote a'} piégé ce réveil`) : null));
  }

  if (!st.alarms.length) {
    out.push(h('section', { class: 'empty' },
      h('h2', {}, 'Aucun réveil'),
      h('p', {}, 'Ajoute ton heure de réveil : tes potes la verront et pourront la piéger avec un son, un message ou un vocal.'),
      h('button', { class: 'btn btn-main', onclick: () => sheetAlarm() }, 'Ajouter un réveil')));
  } else {
    out.push(h('ul', { class: 'alarms' }, st.alarms.map((a) => {
      const trapped = st.incoming.some((w) => w.kind === 'trap' && w.alarm_id === a.id);
      return h('li', { class: `alarm${a.enabled ? '' : ' off'}` },
        h('button', { class: 'alarm-main', onclick: () => sheetAlarm(a), 'aria-label': `Modifier le réveil de ${a.time}` },
          h('span', { class: 'alarm-time' }, a.time),
          h('span', { class: 'alarm-meta' },
            h('span', { class: 'alarm-days' }, [1, 2, 3, 4, 5, 6, 7].map((d) => h('span', { class: a.days.includes(d) ? 'on' : '', title: DAY_LONG[d] }, DAY_LETTERS[d]))),
            h('span', {}, [a.label, `${soundById(a.sound).emoji} ${soundById(a.sound).name}`].filter(Boolean).join(' · ')),
            trapped && a.enabled ? h('span', { class: 'teaser' }, '🤫 piégé') : null)),
        toggle(a.enabled, async (on) => {
          try { await api.saveAlarm({ ...a, enabled: on }); await refresh(); } catch (e) { toast(e.message, 'err'); }
        }, `Activer le réveil de ${a.time}`));
    })));
    out.push(h('button', { class: 'btn btn-main btn-block', onclick: () => sheetAlarm() }, 'Ajouter un réveil'));
  }

  if (st.outgoing.length) {
    out.push(h('h2', { class: 'sec' }, 'Tes pièges en cours'),
      h('ul', { class: 'traps' }, st.outgoing.map((w) => h('li', { class: 'trap' },
        h('span', { class: 'av small' }, w.target.emoji),
        h('div', { class: 'member-txt' },
          h('p', { class: 'member-name' }, `${w.kind === 'trap' ? '😈' : '📣'} ${w.target.pseudo}, ${whenLabel(new Date(w.fire_at))}`),
          h('p', { class: 'member-sub' }, [
            `${soundById(w.sound).emoji} ${soundById(w.sound).name}`,
            w.has_voice ? '🎙️ vocal' : '',
            w.challenge !== 'none' ? `${challengeById(w.challenge).emoji} défi` : '',
            w.message ? `« ${w.message} »` : '',
          ].filter(Boolean).join(' · '))),
        h('button', {
          class: 'btn btn-small', onclick: async () => {
            try { await api.cancelWakeup(w.id); toast('Piège annulé'); await refresh(); } catch (e) { toast(e.message, 'err'); }
          },
        }, 'Annuler')))));
  }
  return out;
}

function toggle(on, onChange, label) {
  const b = h('button', { class: `switch${on ? ' on' : ''}`, role: 'switch', 'aria-checked': String(on), 'aria-label': label });
  b.addEventListener('click', () => {
    const v = !b.classList.contains('on');
    b.classList.toggle('on', v);
    b.setAttribute('aria-checked', String(v));
    onChange(v);
  });
  return b;
}

// ---------------------------------------------------------------------------
// Onglet Le fil

function viewFil() {
  const f = S.feed;
  if (!f) return h('p', { class: 'hint' }, 'Chargement du fil…');
  const out = [];
  const st = f.stats.filter((s) => s.user);
  const top = (arr, key, min = 1) => arr.filter((s) => (s[key] ?? 0) >= min).sort((a, b) => b[key] - a[key])[0];
  const snoozer = top(st, 'snoozes');
  const serial = top(st, 'sent');
  const flash = st.filter((s) => s.wakes > 0 && s.avg_seconds != null).sort((a, b) => a.avg_seconds - b.avg_seconds)[0];
  const awards = [
    snoozer && { emoji: '🐌', title: 'Roi du snooze', who: snoozer.user, val: `${snoozer.snoozes} snooze${snoozer.snoozes > 1 ? 's' : ''}` },
    flash && { emoji: '⚡', title: 'Le plus rapide', who: flash.user, val: `levé en ${duration(flash.avg_seconds)} en moyenne` },
    serial && { emoji: '😈', title: 'Réveilleur en série', who: serial.user, val: `${serial.sent} réveil${serial.sent > 1 ? 's' : ''} envoyé${serial.sent > 1 ? 's' : ''}` },
  ].filter(Boolean);
  if (awards.length) {
    out.push(h('section', { class: 'awards' },
      h('h2', { class: 'sec' }, 'Les trophées du mois'),
      h('ul', {}, awards.map((a) => h('li', { class: 'award' },
        h('span', { class: 'award-emoji' }, a.emoji),
        h('div', {}, h('p', { class: 'award-title' }, a.title), h('p', { class: 'member-sub' }, `${a.who.emoji} ${a.who.pseudo}, ${a.val}`)))))));
  }
  out.push(h('h2', { class: 'sec' }, 'Ce qui s\'est passé'));
  if (!f.events.length) {
    out.push(h('p', { class: 'hint' }, 'Rien pour l\'instant. Piège le réveil d\'un pote pour lancer les hostilités.'));
  } else {
    out.push(h('ul', { class: 'events' }, f.events.map((e) => h('li', { class: `ev ev-${e.type}` },
      h('span', { class: 'av small' }, e.actor?.emoji || '❔'),
      h('div', {}, h('p', {}, eventText(e)), h('p', { class: 'member-sub' }, ago(e.created_at)))))));
  }
  out.push(h('button', { class: 'btn btn-small center-block', onclick: loadFeed }, 'Rafraîchir'));
  return out;
}

function eventText(e) {
  const me = S.state.me.id;
  const a = e.actor?.id === me ? 'Tu' : e.actor?.pseudo || 'Quelqu\'un';
  const t = e.target ? (e.target.id === me ? 'toi' : e.target.pseudo) : '';
  const verb = (moi, autre) => (e.actor?.id === me ? moi : autre);
  switch (e.type) {
    case 'joined': return `${a} ${verb('as', 'a')} rejoint ${e.data.band}.`;
    case 'trap_set': {
      const when = e.data.fire_at ? whenLabel(new Date(e.data.fire_at)) : '';
      const target = e.target?.id === me ? `ton réveil${when ? ` de ${when}` : ''}` : `le réveil de ${t}${when ? ` (${when})` : ''}`;
      const extra = [e.data.voice ? 'avec un vocal' : '', e.data.weekly ? 'avec la surprise de la semaine' : ''].filter(Boolean).join(' et ');
      return `😈 ${a} ${verb('as', 'a')} piégé ${target}${extra ? ` ${extra}` : ''}.`;
    }
    case 'surprise_set': return `📣 ${a} ${verb('as', 'a')} programmé un réveil surprise pour ${t}${e.data.fire_at ? `, ${whenLabel(new Date(e.data.fire_at))}` : ''}.`;
    case 'woke': {
      const by = (e.data.by || []).map((u) => (u.id === me ? 'toi' : u.pseudo));
      const sn = e.data.snoozes ? `, après ${e.data.snoozes} snooze${e.data.snoozes > 1 ? 's' : ''}` : '';
      return `☀️ ${a} ${verb('t\'es', 's\'est')} levé en ${duration(e.data.seconds)}${sn}${by.length ? `. Réveillé par ${by.join(', ')}` : ''}.`;
    }
    case 'snoozed': return `😴 ${a} ${verb('as', 'a')} snoozé${e.data.count > 1 ? ` (${e.data.count}e fois)` : ''}.`;
    case 'reaction': return e.target?.id === me ? `${a} t'a répondu ${e.data.emoji}` : `${a} ${verb('as', 'a')} répondu ${e.data.emoji} à ${t}`;
    default: return `${a} : ${e.type}`;
  }
}

// ---------------------------------------------------------------------------
// Onglet Moi

function viewMoi() {
  const me = S.state.me;
  const ios = isIOS();
  const standalone = isStandalone();
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const out = [];

  out.push(h('section', { class: 'me' },
    h('span', { class: 'av big' }, me.emoji),
    h('div', {}, h('p', { class: 'me-name' }, me.pseudo),
      h('button', { class: 'link', onclick: sheetProfile }, 'Modifier mon profil'))));

  // Installation
  if (!standalone) {
    out.push(h('section', { class: 'panel' },
      h('h2', {}, 'Mets Debout ! sur ton écran d\'accueil'),
      ios
        ? h('ol', { class: 'steps' },
          h('li', {}, 'Ouvre cette page dans Safari.'),
          h('li', {}, 'Touche le bouton Partager (le carré avec une flèche vers le haut).'),
          h('li', {}, 'Choisis « Sur l\'écran d\'accueil », puis « Ajouter ».'),
          h('li', {}, 'Ouvre Debout ! depuis la nouvelle icône : c\'est indispensable pour les notifications sur iPhone.'))
        : S.installEvt
          ? h('button', { class: 'btn btn-main', onclick: async () => { S.installEvt.prompt(); await S.installEvt.userChoice; S.installEvt = null; render(); } }, 'Installer l\'appli')
          : h('p', {}, 'Dans Chrome, ouvre le menu ⋮ puis « Ajouter à l\'écran d\'accueil » ou « Installer l\'application ».')));
  }

  // Notifications
  let notifBody;
  if (!pushSupported) {
    notifBody = h('p', {}, ios && !standalone
      ? 'Sur iPhone, les notifications ne marchent qu\'une fois Debout ! ajouté à l\'écran d\'accueil (voir au-dessus).'
      : 'Ce navigateur ne gère pas les notifications. Utilise le mode dodo pour être réveillé.');
  } else if (perm === 'denied') {
    notifBody = h('p', {}, 'Les notifications sont bloquées pour Debout ! Autorise-les dans les réglages du téléphone, puis reviens ici.');
  } else if (S.state.has_push && perm === 'granted') {
    notifBody = h('div', {},
      h('p', {}, '✅ Activées sur ce téléphone. Tu reçois une notification à chaque réveil, même appli fermée.'),
      h('button', {
        class: 'btn btn-small', onclick: async () => {
          try { await api.testPush(); toast('Notification de test envoyée, elle arrive en moins d\'une minute'); } catch (e) { toast(e.message, 'err'); }
        },
      }, 'Envoyer une notification de test'));
  } else {
    notifBody = h('div', {},
      h('p', {}, 'Active-les pour recevoir tes réveils même quand l\'appli est fermée.'),
      h('button', { class: 'btn btn-main', onclick: enablePush }, 'Activer les notifications'));
  }
  out.push(h('section', { class: 'panel' }, h('h2', {}, 'Notifications'), notifBody,
    h('p', { class: 'hint' }, 'Une notification utilise le son normal du téléphone et peut être coupée par le mode silencieux. Pour un vrai réveil qui sonne fort, utilise le mode dodo.')));

  // Test sonnerie
  out.push(h('section', { class: 'panel' },
    h('h2', {}, 'Tester la sonnerie'),
    h('p', {}, 'Vérifie que ton téléphone sonne assez fort. Monte le volume des médias.'),
    h('button', {
      class: 'btn', onclick: () => {
        unlockAudio();
        ring({ key: `test:${Date.now()}`, fireAt: new Date(), kind: 'test', sound: 'fanfare', challenge: 'none', wakeups: [], voiceIds: [] });
      },
    }, '🔊 Faire sonner maintenant')));

  // Code de récupération
  const code = token();
  out.push(h('section', { class: 'panel' },
    h('h2', {}, 'Code de récupération'),
    h('p', {}, 'Ton compte est lié à ce téléphone. Garde ce code pour le retrouver sur un autre téléphone. Ne le donne à personne : il permet de se connecter à ta place.'),
    h('details', {}, h('summary', {}, 'Afficher le code'),
      h('p', { class: 'mono code' }, code.match(/.{1,6}/g).join(' ')),
      h('button', { class: 'btn btn-small', onclick: () => copy(code, 'Code copié') }, 'Copier'))));

  // Bandes
  if (S.state.bands.length) {
    out.push(h('section', { class: 'panel' },
      h('h2', {}, 'Mes bandes'),
      h('ul', { class: 'plain' }, S.state.bands.map((b) => h('li', { class: 'band-line' },
        h('span', {}, `${b.name} (${b.members.length})`),
        h('button', {
          class: 'link danger', onclick: async () => {
            if (!confirm(`Quitter la bande « ${b.name} » ?`)) return;
            try { await api.leaveBand(b.id); await refresh(); } catch (e) { toast(e.message, 'err'); }
          },
        }, 'Quitter'))))));
  }

  out.push(h('section', { class: 'panel quiet' },
    h('button', {
      class: 'link danger', onclick: async () => {
        if (!confirm('Supprimer ton compte, tes réveils et tes pièges ? C\'est définitif.')) return;
        try { await api.deleteAccount(); } catch { /* */ }
        store.del('token'); location.reload();
      },
    }, 'Supprimer mon compte'),
    h('p', { class: 'hint' }, 'Debout ! v1. Sons et défis originaux.')));
  return out;
}

async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch { prompt('Copie ce texte :', text); }
}

// ============================================================================
// Feuilles (panneaux du bas)

function openSheet(title, body, { onClose } = {}) {
  S.sheetOpen += 1;
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-head' },
      h('h2', {}, title),
      h('button', { class: 'x', 'aria-label': 'Fermer', onclick: () => close() }, '✕')),
    h('div', { class: 'sheet-body' }, body));
  const wrap = h('div', { class: 'sheet-wrap', onclick: (e) => { if (e.target === wrap) close(); } }, panel);
  document.body.append(wrap);
  document.body.classList.add('no-scroll');
  requestAnimationFrame(() => wrap.classList.add('open'));
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    stopPreview();
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 250);
    S.sheetOpen -= 1;
    if (!S.sheetOpen) document.body.classList.remove('no-scroll');
    onClose?.();
    if (S.pendingRender) setTimeout(render, 260);
  }
  return { close, panel };
}

function sheetCreateBand() {
  const name = h('input', { class: 'field', maxlength: 40, placeholder: 'Ex. : Les marmottes', 'aria-label': 'Nom de la bande' });
  const s = openSheet('Créer une bande', h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      if (!name.value.trim()) { name.focus(); return; }
      try {
        const b = await api.createBand(name.value.trim());
        s.close();
        await refresh();
        sheetInvite(b);
      } catch (err) { toast(err.message, 'err'); }
    },
  }, h('label', { class: 'lbl' }, 'Nom de la bande'), name, h('button', { class: 'btn btn-main btn-block' }, 'Créer la bande')));
  setTimeout(() => name.focus(), 300);
}

function sheetJoinBand() {
  const code = h('input', { class: 'field mono upper', maxlength: 6, placeholder: 'ABC123', autocapitalize: 'characters', autocomplete: 'off', 'aria-label': 'Code de la bande' });
  const s = openSheet('Rejoindre une bande', h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        const b = await api.joinBand(code.value.trim());
        s.close();
        toast(`Bienvenue dans « ${b.name} » 🎉`);
        await refresh();
      } catch (err) { toast(err.message, 'err'); }
    },
  }, h('label', { class: 'lbl' }, 'Le code à 6 caractères envoyé par ton pote'), code,
  h('button', { class: 'btn btn-main btn-block' }, 'Rejoindre')));
  setTimeout(() => code.focus(), 300);
}

function inviteLink(b) {
  return `${location.origin}${location.pathname}?bande=${b.code}`;
}

function sheetInvite(b) {
  const link = inviteLink(b);
  const text = `Rejoins ma bande « ${b.name} » sur Debout ! On se piège nos réveils entre potes 😈`;
  openSheet(`Inviter dans ${b.name}`, h('div', { class: 'stack' },
    h('p', {}, 'Envoie ce lien à tes potes (WhatsApp, SMS…). Ils l\'ouvrent, choisissent un surnom, et ils sont dans la bande. Ça marche sur iPhone comme sur Android.'),
    h('p', { class: 'hint' }, 'Ils auront aussi besoin du mot de passe d\'accès. Donne-le à part, pas dans le même message que le lien.'),
    h('p', { class: 'big-code', 'aria-label': `Code ${b.code.split('').join(' ')}` }, b.code),
    navigator.share
      ? h('button', { class: 'btn btn-main btn-block', onclick: () => navigator.share({ title: 'Debout !', text, url: link }).catch(() => {}) }, 'Partager le lien')
      : null,
    h('button', { class: 'btn btn-block', onclick: () => copy(`${text}\n${link}`, 'Lien copié') }, 'Copier le lien'),
  ));
}

function sheetManage(b) {
  const others = b.members.filter((m) => m.id !== S.state.me.id);
  const s = openSheet(`Gérer ${b.name}`, h('div', { class: 'stack' },
    h('p', { class: 'hint' }, 'Tu as créé cette bande : tu peux exclure quelqu\'un et changer le code d\'invitation.'),
    others.length ? h('ul', { class: 'members' }, others.map((m) => h('li', { class: 'member' },
      h('span', { class: 'av small' }, m.emoji),
      h('div', { class: 'member-txt' }, h('p', { class: 'member-name' }, m.pseudo)),
      h('button', {
        class: 'btn btn-small', onclick: async () => {
          if (!confirm(`Exclure ${m.pseudo} de « ${b.name} » ? Ses pièges en attente seront annulés.`)) return;
          try { await api.kick(b.id, m.id); toast(`${m.pseudo} a été exclu`); s.close(); await refresh(); } catch (e) { toast(e.message, 'err'); }
        },
      }, 'Exclure')))) : h('p', {}, 'Personne d\'autre dans la bande pour l\'instant.'),
    h('h3', { class: 'lbl' }, 'Code d\'invitation'),
    h('p', { class: 'hint' }, `Code actuel : ${b.code}. Si le lien a circulé trop loin, change-le : l'ancien lien ne marchera plus. Les membres actuels restent dans la bande.`),
    h('button', {
      class: 'btn btn-block', onclick: async () => {
        if (!confirm('Changer le code d\'invitation ? L\'ancien lien ne marchera plus.')) return;
        try { const nb = await api.newCode(b.id); s.close(); await refresh(); sheetInvite({ ...b, code: nb.code }); } catch (e) { toast(e.message, 'err'); }
      },
    }, 'Changer le code d\'invitation'),
  ));
}

function sheetProfile() {
  const me = S.state.me;
  let emoji = me.emoji;
  const pseudo = h('input', { class: 'field', maxlength: 24, value: me.pseudo, 'aria-label': 'Surnom' });
  const grid = h('div', { class: 'avatars' }, AVATARS.map((a) => h('button', {
    type: 'button', class: `avatar-pick${a === emoji ? ' on' : ''}`,
    onclick: (e) => { emoji = a; grid.querySelectorAll('.on').forEach((x) => x.classList.remove('on')); e.currentTarget.classList.add('on'); },
  }, a)));
  const s = openSheet('Mon profil', h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      try { await api.updateProfile(pseudo.value.trim() || me.pseudo, emoji); s.close(); await refresh(); } catch (err) { toast(err.message, 'err'); }
    },
  }, h('label', { class: 'lbl' }, 'Surnom'), pseudo, h('label', { class: 'lbl' }, 'Avatar'), grid,
  h('button', { class: 'btn btn-main btn-block' }, 'Enregistrer')));
}

// --- Éditeur de réveil ------------------------------------------------------

function sheetAlarm(a = null) {
  const isNew = !a;
  const v = a ? { ...a, days: [...a.days] } : { time: '07:30', days: [1, 2, 3, 4, 5], label: '', sound: 'classique', challenge: 'none', enabled: true, tz: localTz() };
  const time = h('input', { type: 'time', class: 'field time-field', value: v.time, required: true, 'aria-label': 'Heure' });
  const days = h('div', { class: 'days' });
  const drawDays = () => days.replaceChildren(...[1, 2, 3, 4, 5, 6, 7].map((d) => h('button', {
    type: 'button', class: `day${v.days.includes(d) ? ' on' : ''}`, 'aria-pressed': String(v.days.includes(d)), 'aria-label': DAY_LONG[d],
    onclick: () => { v.days = v.days.includes(d) ? v.days.filter((x) => x !== d) : [...v.days, d]; drawDays(); },
  }, DAY_LETTERS[d])));
  drawDays();
  const presets = h('div', { class: 'chips' }, [['En semaine', [1, 2, 3, 4, 5]], ['Week-end', [6, 7]], ['Tous les jours', [1, 2, 3, 4, 5, 6, 7]]]
    .map(([n, ds]) => h('button', { type: 'button', class: 'chip', onclick: () => { v.days = [...ds]; drawDays(); } }, n)));
  const label = h('input', { class: 'field', maxlength: 30, value: v.label, placeholder: 'Ex. : Boulot, Sport…', 'aria-label': 'Nom du réveil' });
  const sounds = soundPicker(SOUNDS, () => v.sound, (id) => { v.sound = id; });
  const chals = challengePicker(() => v.challenge, (id) => { v.challenge = id; });

  const body = h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      if (!v.days.length) { toast('Choisis au moins un jour', 'err'); return; }
      v.time = time.value || v.time;
      v.label = label.value.trim();
      try { await api.saveAlarm(v); s.close(); toast(isNew ? 'Réveil ajouté. Tes potes peuvent le piéger.' : 'Réveil modifié'); await refresh(); } catch (err) { toast(err.message, 'err'); }
    },
  },
  time,
  h('label', { class: 'lbl' }, 'Jours'), days, presets,
  h('label', { class: 'lbl' }, 'Nom (facultatif)'), label,
  h('label', { class: 'lbl' }, 'Ton son, si personne ne le piège'), sounds,
  h('label', { class: 'lbl' }, 'Défi pour couper'), chals,
  h('button', { class: 'btn btn-main btn-block' }, isNew ? 'Ajouter le réveil' : 'Enregistrer'),
  isNew ? null : h('button', {
    type: 'button', class: 'link danger center-block', onclick: async () => {
      if (!confirm('Supprimer ce réveil ?')) return;
      try { await api.deleteAlarm(a.id); s.close(); await refresh(); } catch (err) { toast(err.message, 'err'); }
    },
  }, 'Supprimer ce réveil'));
  const s = openSheet(isNew ? 'Nouveau réveil' : 'Modifier le réveil', body);
}

function soundPicker(list, get, set) {
  const wrap = h('div', { class: 'sounds' });
  const draw = () => wrap.replaceChildren(...list.map((snd) => h('button', {
    type: 'button', class: `sound${get() === snd.id ? ' on' : ''}`, 'aria-pressed': String(get() === snd.id),
    onclick: () => { set(snd.id); previewSound(snd.id); draw(); },
  }, h('span', { class: 'sound-emoji' }, snd.emoji), h('span', {}, snd.name))));
  draw();
  return wrap;
}

function challengePicker(get, set) {
  const wrap = h('div', { class: 'chips' });
  const draw = () => wrap.replaceChildren(...CHALLENGES.map((c) => h('button', {
    type: 'button', class: `chip${get() === c.id ? ' on' : ''}`, 'aria-pressed': String(get() === c.id), title: c.desc,
    onclick: () => { set(c.id); draw(); },
  }, `${c.emoji} ${c.name}`)));
  draw();
  return wrap;
}

// --- Réveiller un pote -------------------------------------------------------

function sheetCompose(m) {
  const occ = memberNext(m).slice(0, 8);
  const wk = weeklySurprise();
  const c = {
    kind: occ.length ? 'trap' : 'surprise',
    pick: occ[0] || null,
    sound: 'sirene', message: '', voice: null, challenge: 'none', weekly: null,
    sDay: 0, sTime: '',
  };
  const d0 = new Date(Date.now() + 15 * 60000);
  c.sTime = `${String(d0.getHours()).padStart(2, '0')}:${String(d0.getMinutes()).padStart(2, '0')}`;

  const whenBox = h('div', { class: 'stack' });
  const modes = h('div', { class: 'seg' });
  const drawModes = () => modes.replaceChildren(
    h('button', {
      type: 'button', class: `seg-btn${c.kind === 'trap' ? ' on' : ''}`, disabled: !occ.length,
      onclick: () => { c.kind = 'trap'; drawModes(); drawWhen(); },
    }, '😈 Piéger son réveil'),
    h('button', {
      type: 'button', class: `seg-btn${c.kind === 'surprise' ? ' on' : ''}`,
      onclick: () => { c.kind = 'surprise'; drawModes(); drawWhen(); },
    }, '📣 Réveil surprise'),
  );
  const drawWhen = () => {
    if (c.kind === 'trap') {
      whenBox.replaceChildren(
        h('p', { class: 'hint' }, `Quand le réveil de ${m.pseudo} sonnera, ce sera avec ton son, ton message et ton vocal.`),
        h('div', { class: 'chips' }, occ.map((o) => h('button', {
          type: 'button', class: `chip${c.pick === o ? ' on' : ''}`,
          onclick: () => { c.pick = o; drawWhen(); },
        }, `${whenLabel(o.at)}${o.alarm.label ? ` · ${o.alarm.label}` : ''}`))));
    } else {
      const dayNames = ['Aujourd\'hui', 'Demain', 'Après-demain'];
      const t = h('input', { type: 'time', class: 'field time-field small', value: c.sTime, 'aria-label': 'Heure du réveil surprise', oninput: (e) => { c.sTime = e.target.value; } });
      whenBox.replaceChildren(
        h('p', { class: 'hint' }, `Son téléphone sonnera à l'heure que tu choisis, même s'il n'a pas mis de réveil. ${m.pseudo} ne sera pas prévenu avant.`),
        h('div', { class: 'chips' }, dayNames.map((n, i) => h('button', {
          type: 'button', class: `chip${c.sDay === i ? ' on' : ''}`, onclick: () => { c.sDay = i; drawWhen(); },
        }, n))), t);
    }
  };
  drawModes(); drawWhen();

  // surprise de la semaine
  const weeklyBtn = h('button', { type: 'button', class: 'weekly-pick' });
  const drawWeekly = () => {
    weeklyBtn.className = `weekly-pick${c.weekly ? ' on' : ''}`;
    weeklyBtn.replaceChildren(
      h('span', { class: 'weekly-emoji' }, wk.emoji),
      h('span', {}, h('strong', {}, c.weekly ? `${wk.name} : activé` : `Utiliser « ${wk.name} »`),
        h('span', { class: 'member-sub block' }, `Son exclusif de la semaine + défi « ${challengeById(wk.challenge).name.toLowerCase()} »`)));
  };
  weeklyBtn.addEventListener('click', () => {
    c.weekly = c.weekly ? null : wk.id;
    if (c.weekly) { c.sound = wk.sound; c.challenge = wk.challenge; previewSound(wk.sound); }
    drawWeekly(); soundsEl.replaceWith(soundsEl = mkSounds()); chalsEl.replaceWith(chalsEl = mkChals());
  });
  drawWeekly();
  const mkSounds = () => soundPicker(SOUNDS, () => (c.weekly ? null : c.sound), (id) => { c.sound = id; c.weekly = null; drawWeekly(); });
  const mkChals = () => challengePicker(() => c.challenge, (id) => { c.challenge = id; if (c.weekly && id !== wk.challenge) { c.weekly = null; c.sound = 'sirene'; drawWeekly(); soundsEl.replaceWith(soundsEl = mkSounds()); } });
  let soundsEl = mkSounds();
  let chalsEl = mkChals();

  const msg = h('textarea', { class: 'field', maxlength: 160, rows: 2, placeholder: 'Allez debout la marmotte', 'aria-label': 'Message', oninput: (e) => { c.message = e.target.value; } });

  const voiceBox = h('div', { class: 'voice' });
  let rec = null;
  const drawVoice = (state = 'idle', secs = 0) => {
    if (!canRecord()) { voiceBox.replaceChildren(h('p', { class: 'hint' }, 'Ce navigateur ne permet pas d\'enregistrer un vocal.')); return; }
    if (state === 'rec') {
      voiceBox.replaceChildren(h('button', {
        type: 'button', class: 'btn btn-rec on', onclick: async () => {
          try { const r = await rec.stop(); c.voice = r; drawVoice('has'); } catch { toast('Le vocal n\'a pas pu être enregistré', 'err'); drawVoice(); }
        },
      }, `⏹ Arrêter (${secs} s / ${MAX_VOICE_S} s)`));
    } else if (state === 'has' && c.voice) {
      voiceBox.replaceChildren(
        h('button', { type: 'button', class: 'btn', onclick: () => previewSound(c.voice.dataUrl, 0) }, `▶︎ Écouter (${Math.round(c.voice.seconds)} s)`),
        h('button', { type: 'button', class: 'btn', onclick: () => { c.voice = null; stopPreview(); drawVoice(); } }, '🗑 Supprimer'));
    } else {
      voiceBox.replaceChildren(h('button', {
        type: 'button', class: 'btn btn-rec', onclick: async () => {
          try {
            rec = await startRecording();
            let s = 0;
            drawVoice('rec', 0);
            const iv = setInterval(() => { s += 1; if (s > MAX_VOICE_S) { clearInterval(iv); return; } drawVoice('rec', s); }, 1000);
            rec.done.then((r) => { clearInterval(iv); c.voice = r; drawVoice('has'); }).catch(() => { clearInterval(iv); drawVoice(); });
          } catch { toast('Autorise le micro pour enregistrer un vocal', 'err'); }
        },
      }, '🎙️ Enregistrer un vocal'));
    }
  };
  drawVoice();

  const send = h('button', { class: 'btn btn-prank btn-block' });
  const drawSend = () => { send.textContent = c.kind === 'trap' ? 'Poser le piège' : 'Programmer le réveil surprise'; };
  drawSend();
  modes.addEventListener('click', drawSend);

  const form = h('form', {
    class: 'stack',
    onsubmit: async (e) => {
      e.preventDefault();
      let fireAt, alarmId = null;
      if (c.kind === 'trap') {
        if (!c.pick) { toast('Choisis quelle sonnerie piéger', 'err'); return; }
        fireAt = c.pick.at; alarmId = c.pick.alarm.id;
      } else {
        const [hh, mm] = (c.sTime || '').split(':').map(Number);
        if (Number.isNaN(hh)) { toast('Choisis une heure', 'err'); return; }
        const d = new Date(); d.setDate(d.getDate() + c.sDay); d.setHours(hh, mm, 0, 0);
        if (d < new Date()) { toast('Cette heure est déjà passée', 'err'); return; }
        fireAt = d;
      }
      send.disabled = true;
      send.textContent = 'Envoi…';
      try {
        await api.sendWakeup({
          target: m.id, kind: c.kind, alarmId, fireAt: fireAt.toISOString(), sound: c.sound,
          message: c.message.trim(), voice: c.voice?.dataUrl, challenge: c.challenge, weekly: c.weekly,
        });
        s.close();
        toast(c.kind === 'trap' ? `Piège posé. ${m.pseudo} ne se doute de rien 😈` : `Réveil surprise programmé pour ${m.pseudo} 📣`);
        await refresh();
      } catch (err) { toast(err.message, 'err'); send.disabled = false; drawSend(); }
    },
  },
  modes, whenBox,
  h('label', { class: 'lbl' }, 'Surprise de la semaine'), weeklyBtn,
  h('label', { class: 'lbl' }, 'Le son'), soundsEl,
  h('label', { class: 'lbl' }, 'Ton message'), msg,
  h('label', { class: 'lbl' }, 'Ton vocal (12 s max)'), voiceBox,
  h('label', { class: 'lbl' }, 'Défi pour couper'), chalsEl,
  send);
  // les pickers sont recréés : on garde les références à jour dans le formulaire
  const s = openSheet(`Réveiller ${m.emoji} ${m.pseudo}`, form);
}

// ============================================================================
// Mode dodo

let sleepEl = null;
let sleepHow = 'wakelock';

async function enterSleep() {
  await unlockAudio({ keep: true });
  sleepHow = await keepScreenOn();
  S.sleeping = true;
  document.body.classList.add('no-scroll');
  renderSleep();
  preloadSounds(['classique', ...nextOccs().slice(0, 4).map((o) => o.sound)]);
  prefetchVoices();
}

function exitSleep() {
  S.sleeping = false;
  releaseScreen();
  stopRinging();
  sleepEl?.remove();
  sleepEl = null;
  document.body.classList.remove('no-scroll');
  render();
}

function renderSleep() {
  const nxt = nextOccs()[0];
  const holdBtn = h('button', { class: 'sleep-exit' }, 'Maintenir pour sortir');
  let holdT;
  holdBtn.addEventListener('pointerdown', () => { holdBtn.classList.add('holding'); holdT = setTimeout(exitSleep, 1200); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => holdBtn.addEventListener(ev, () => { holdBtn.classList.remove('holding'); clearTimeout(holdT); }));
  const traps = nxt ? nxt.wakeups.filter((w) => w.kind !== 'snooze').length : 0;
  const el = h('div', { class: 'sleep', role: 'dialog', 'aria-label': 'Mode dodo' },
    h('div', { class: 'sleep-inner' },
      h('p', { class: 'sleep-clock' }, hhmm(new Date())),
      h('p', { class: 'sleep-next' }, nxt
        ? `Réveil ${whenLabel(nxt.fireAt)}${traps ? (nxt.kind === 'surprise' ? ' · réveil surprise 📣' : ' · piégé 🤫') : ''}`
        : 'Aucun réveil prévu. Tes potes peuvent encore t\'envoyer un réveil surprise.'),
      h('p', { class: 'sleep-tip' }, sleepHow === 'none'
        ? '⚠️ Ce téléphone risque de se verrouiller tout seul. Règle le verrouillage automatique sur « Jamais » pour cette nuit.'
        : 'Laisse le téléphone branché, écran allumé, et ne quitte pas l\'appli. Le volume des médias doit être monté.')),
    holdBtn);
  if (sleepEl) sleepEl.replaceWith(el); else document.body.append(el);
  sleepEl = el;
  keepAlive();
}

let lastShift = 0;
function updateSleepClock() {
  if (!sleepEl) return;
  const c = sleepEl.querySelector('.sleep-clock');
  if (c) c.textContent = hhmm(new Date());
  if (Date.now() - lastShift > 60000) {
    lastShift = Date.now();
    const inner = sleepEl.querySelector('.sleep-inner');
    if (inner) inner.style.transform = `translate(${Math.round(Math.random() * 30 - 15)}px, ${Math.round(Math.random() * 60 - 30)}px)`;
  }
}

// ============================================================================
// Notifications push

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

async function enablePush() {
  try {
    if (!CONFIG.vapidPublic) { toast('Les notifications ne sont pas encore configurées sur le serveur', 'err'); return; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications refusées. Tu peux changer ça dans les réglages du téléphone.', 'err'); render(); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(CONFIG.vapidPublic) });
    await api.savePush(sub.toJSON());
    toast('Notifications activées ✅');
    await refresh();
  } catch (e) {
    toast(`Impossible d'activer les notifications : ${e.message || e}`, 'err');
  }
}

async function resyncPush() {
  try {
    if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await api.savePush(sub.toJSON());
  } catch { /* pas grave */ }
}
