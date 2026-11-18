// Écran de sonnerie + défis pour couper.
import { h, hhmm, duration } from './util.js';
import { challengeById, soundById, REACTIONS, PHRASES } from './data.js';
import { startRinging, stopRinging, startVibrate, stopVibrate } from './audio.js';

let current = null;
export const isRinging = () => !!current;

export const MAX_SNOOZES = 3;

/**
 * occ : { key, fireAt, alarmId, label, sound, challenge, wakeups[], voices[], kind }
 * ctx : { needsTap, snoozes, firstRingAt, sleepMode, onSnooze, onStop, onReact, onClose }
 */
export function showRing(occ, ctx) {
  if (current) return;
  const root = h('div', { class: 'ring', role: 'dialog', 'aria-label': 'Réveil' });
  current = { root, occ };
  document.body.append(root);
  document.body.classList.add('no-scroll');

  const senders = uniqueSenders(occ.wakeups);
  const firstRingAt = ctx.firstRingAt || Date.now();
  const snoozes = ctx.snoozes || 0;

  const startAudio = () => startRinging(occ.sound, occ.voices || []);

  const head = h('div', { class: 'ring-head' },
    h('div', { class: 'ring-clock' }, hhmm(new Date())),
    h('h1', { class: 'ring-title' }, 'Debout\u00a0!'),
    h('p', { class: 'ring-from' }, fromLine(occ, senders)),
  );
  const msgs = h('div', { class: 'ring-msgs' },
    occ.wakeups.filter((w) => w.message || w.has_voice).map((w) =>
      h('div', { class: 'bubble' },
        h('span', { class: 'bubble-who' }, `${w.sender.emoji} ${w.sender.pseudo}`),
        w.message ? h('span', { class: 'bubble-text' }, w.message) : null,
        w.has_voice ? h('span', { class: 'bubble-voice' }, '🎙️ Message vocal') : null,
      )),
  );
  const zone = h('div', { class: 'ring-zone' });
  root.append(head, msgs, zone);

  const clockTimer = setInterval(() => { head.querySelector('.ring-clock').textContent = hhmm(new Date()); }, 5000);

  function close() {
    clearInterval(clockTimer);
    stopVibrate();
    root.classList.add('leaving');
    setTimeout(() => root.remove(), 250);
    document.body.classList.remove('no-scroll');
    current = null;
    ctx.onClose?.();
  }

  function actions() {
    zone.replaceChildren(
      h('p', { class: 'ring-sound' }, `${soundById(occ.sound).emoji} ${soundById(occ.sound).name}`,
        occ.challenge !== 'none' ? ` · défi : ${challengeById(occ.challenge).name.toLowerCase()}` : ''),
      h('div', { class: 'ring-actions' },
        h('button', {
          class: 'btn btn-ghost-light', disabled: snoozes >= MAX_SNOOZES,
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            stopRinging({ keepSession: ctx.sleepMode });
            stopVibrate();
            await ctx.onSnooze(occ, { snoozes: snoozes + 1, firstRingAt });
            close();
          },
        }, snoozes >= MAX_SNOOZES ? 'Plus de snooze' : `Snooze 5 min${senders.length ? ' (tes potes le verront)' : ''}`),
        h('button', { class: 'btn btn-wake', onclick: () => runChallenge() }, 'Je suis debout'),
      ),
    );
  }

  async function runChallenge() {
    if (occ.challenge && occ.challenge !== 'none') {
      zone.replaceChildren();
      await CHALLENGE_UI[occ.challenge](zone);
    }
    stopRinging({ keepSession: ctx.sleepMode });
    stopVibrate();
    const seconds = (Date.now() - firstRingAt) / 1000;
    zone.replaceChildren(h('p', { class: 'ring-sound' }, 'Enregistrement…'));
    let res = null;
    try { res = await ctx.onStop(occ, { seconds, snoozes }); } catch { /* hors ligne : tant pis pour le fil */ }
    done(seconds, (res && res.senders) || senders);
  }

  function done(seconds, who) {
    root.classList.add('ring-done');
    head.querySelector('.ring-title').textContent = 'Bien joué';
    head.querySelector('.ring-from').textContent = `Levé en ${duration(seconds)}${snoozes ? `, après ${snoozes} snooze${snoozes > 1 ? 's' : ''}` : ''}.`;
    msgs.remove();
    zone.replaceChildren(...[
      who.length ? h('div', { class: 'react' },
        h('p', {}, who.length > 1 ? 'Réponds à tes réveilleurs :' : `Réponds à ${who[0].pseudo} :`),
        who.map((s) => h('div', { class: 'react-row' },
          who.length > 1 ? h('span', { class: 'react-who' }, `${s.emoji} ${s.pseudo}`) : null,
          h('div', { class: 'react-emojis' }, REACTIONS.map((em) => h('button', {
            class: 'react-btn', 'aria-label': `Envoyer ${em} à ${s.pseudo}`,
            onclick: (e) => {
              ctx.onReact?.(s.id, em);
              e.currentTarget.parentElement.replaceChildren(h('span', { class: 'react-sent' }, `${em} envoyé`));
            },
          }, em))),
        )),
      ) : null,
      h('button', { class: 'btn btn-wake', onclick: close }, 'Fermer'),
    ].filter(Boolean));
  }

  if (ctx.needsTap) {
    zone.replaceChildren(
      h('button', {
        class: 'btn btn-wake btn-huge',
        onclick: async () => { await startAudio(); startVibrate(); actions(); },
      }, '▶︎ Lancer le réveil'),
    );
  } else {
    startAudio().then((ok) => {
      if (ok) { startVibrate(); actions(); return; }
      // le navigateur a bloqué le son : il faut un tap
      zone.replaceChildren(h('button', {
        class: 'btn btn-wake btn-huge',
        onclick: async () => { await startAudio(); startVibrate(); actions(); },
      }, '▶︎ Lancer le réveil'));
    });
    startVibrate();
    actions();
  }
  return { close };
}

function uniqueSenders(wakeups) {
  const seen = new Map();
  for (const w of wakeups || []) if (w.sender && w.kind !== 'snooze') seen.set(w.sender.id, w.sender);
  return [...seen.values()];
}

function fromLine(occ, senders) {
  const names = senders.map((s) => `${s.emoji} ${s.pseudo}`).join(', ');
  if (occ.kind === 'surprise') return `Réveil surprise de ${names}`;
  if (occ.kind === 'snooze') return senders.length ? `Fin du snooze. ${names} t'attend${senders.length > 1 ? 'ent' : ''}.` : 'Fin du snooze.';
  if (occ.kind === 'test') return 'Test de la sonnerie';
  if (senders.length) return `${names} ${senders.length > 1 ? 'ont' : 'a'} piégé ton réveil${occ.label ? ` « ${occ.label} »` : ''}`;
  return occ.label || 'Ton réveil';
}

// ---------------------------------------------------------------------------
// Défis : chaque fonction remplit la zone et se résout quand c'est réussi.

const CHALLENGE_UI = {
  taps(zone) {
    return new Promise((resolve) => {
      let left = 40;
      const count = h('span', { class: 'chal-count' }, left);
      const btn = h('button', {
        class: 'chal-tap', 'aria-label': 'Taper',
        onpointerdown: (e) => {
          e.preventDefault();
          left -= 1;
          count.textContent = left;
          btn.animate([{ transform: 'scale(.92)' }, { transform: 'scale(1)' }], { duration: 120 });
          if (left <= 0) resolve();
        },
      }, count);
      zone.append(h('p', { class: 'chal-title' }, 'Tape 40 fois pour couper'), btn);
    });
  },

  maths(zone) {
    return new Promise((resolve) => {
      const r = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
      const qs = [
        () => { const a = r(12, 89), b = r(12, 89); return [`${a} + ${b}`, a + b]; },
        () => { const a = r(3, 9), b = r(12, 25); return [`${a} × ${b}`, a * b]; },
        () => { const a = r(50, 99), b = r(11, 49); return [`${a} − ${b}`, a - b]; },
      ].map((f) => f());
      let i = 0;
      const label = h('p', { class: 'chal-q' });
      const step = h('p', { class: 'chal-title' });
      const input = h('input', { class: 'chal-input', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off', 'aria-label': 'Ta réponse' });
      const show = () => { step.textContent = `Calcul ${i + 1} sur 3`; label.textContent = `${qs[i][0]} = ?`; input.value = ''; input.focus(); };
      const form = h('form', {
        class: 'chal-form',
        onsubmit: (e) => {
          e.preventDefault();
          if (Number(input.value) === qs[i][1]) {
            i += 1;
            if (i >= qs.length) resolve(); else show();
          } else {
            input.classList.add('shake');
            setTimeout(() => input.classList.remove('shake'), 400);
            input.value = '';
          }
        },
      }, input, h('button', { class: 'btn btn-wake' }, 'Valider'));
      zone.append(step, label, form);
      show();
    });
  },

  phrase(zone) {
    return new Promise((resolve) => {
      const phrase = PHRASES[Math.floor(Math.random() * PHRASES.length)];
      const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
      const input = h('input', { class: 'chal-input chal-text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Recopie la phrase' });
      const form = h('form', {
        class: 'chal-form',
        onsubmit: (e) => {
          e.preventDefault();
          if (norm(input.value) === norm(phrase)) resolve();
          else { input.classList.add('shake'); setTimeout(() => input.classList.remove('shake'), 400); }
        },
      }, input, h('button', { class: 'btn btn-wake' }, 'Valider'));
      zone.append(h('p', { class: 'chal-title' }, 'Recopie sans faute :'), h('p', { class: 'chal-q chal-phrase' }, `« ${phrase} »`), form);
      input.focus();
    });
  },

  hold(zone) {
    return new Promise((resolve) => {
      const need = 8000;
      let start = 0, raf = 0;
      const fill = h('span', { class: 'chal-fill' });
      const txt = h('span', { class: 'chal-hold-txt' }, 'Appuie et tiens');
      const btn = h('button', { class: 'chal-hold', 'aria-label': 'Maintenir appuyé' }, fill, txt);
      const tick = () => {
        const p = Math.min(1, (Date.now() - start) / need);
        fill.style.transform = `scaleX(${p})`;
        txt.textContent = `${Math.ceil((need - (Date.now() - start)) / 1000)} s`;
        if (p >= 1) { cancelAnimationFrame(raf); resolve(); return; }
        raf = requestAnimationFrame(tick);
      };
      const down = (e) => { e.preventDefault(); start = Date.now(); btn.setPointerCapture?.(e.pointerId); tick(); };
      const up = () => { cancelAnimationFrame(raf); fill.style.transform = 'scaleX(0)'; txt.textContent = 'Raté, recommence'; };
      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
      zone.append(h('p', { class: 'chal-title' }, 'Garde le doigt appuyé 8 secondes'), btn);
    });
  },

  memory(zone) {
    return new Promise((resolve) => {
      const colors = [['jaune', '#FFD23F'], ['rose', '#FF5D8F'], ['bleu', '#4DA8FF'], ['vert', '#3DDC97']];
      const title = h('p', { class: 'chal-title' }, 'Regarde bien…');
      const pads = colors.map(([name, c], i) => h('button', { class: 'pad', style: { background: c }, 'aria-label': name, 'data-i': i }));
      const grid = h('div', { class: 'pads' }, pads);
      zone.append(title, grid);
      let seq = [], pos = 0, locked = true;
      const flash = (i) => new Promise((r) => {
        pads[i].classList.add('lit');
        setTimeout(() => { pads[i].classList.remove('lit'); setTimeout(r, 180); }, 450);
      });
      const play = async () => {
        locked = true;
        title.textContent = 'Regarde bien…';
        seq = Array.from({ length: 5 }, () => Math.floor(Math.random() * 4));
        pos = 0;
        await new Promise((r) => setTimeout(r, 600));
        for (const i of seq) await flash(i);
        title.textContent = 'À toi : refais la suite';
        locked = false;
      };
      pads.forEach((p, i) => p.addEventListener('click', () => {
        if (locked) return;
        flash(i);
        if (i === seq[pos]) {
          pos += 1;
          if (pos >= seq.length) { locked = true; resolve(); }
        } else {
          title.textContent = 'Raté ! Nouvelle suite…';
          grid.classList.add('shake');
          setTimeout(() => { grid.classList.remove('shake'); play(); }, 700);
          locked = true;
        }
      }));
      play();
    });
  },
};
