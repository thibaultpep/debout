// Accès au serveur (Supabase, via les fonctions RPC).
import { CONFIG } from './config.js';
import { store } from './util.js';

const ERRORS = {
  AUTH: 'Ton compte est introuvable sur ce téléphone.',
  BAND_NOT_FOUND: "Ce code ne correspond à aucune bande. Vérifie les 6 caractères.",
  BAND_FULL: 'Cette bande est complète (30 membres).',
  TOO_MANY_BANDS: 'Tu es déjà dans 10 bandes, quitte-en une pour en créer une autre.',
  TOO_MANY_ALARMS: '12 réveils maximum. Supprime-en un pour en ajouter un autre.',
  NOT_A_MATE: "Cette personne n'est pas dans une de tes bandes.",
  NOT_YOURSELF: 'Tu ne peux pas te piéger toi-même.',
  BAD_TIME: "L'heure choisie est passée ou trop lointaine (8 jours max).",
  TOO_MANY_PENDING: 'Tu as déjà 6 réveils en attente pour ce pote. Laisse-le respirer.',
  ALARM_NOT_FOUND: "Ce réveil n'existe plus, ton pote l'a modifié.",
  BAD_OCCURRENCE: "Ce réveil a changé d'heure entre-temps. Rafraîchis et recommence.",
  NOT_FOUND: 'Élément introuvable.',
};

export class ApiError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

export const token = () => store.get('token');

export async function rpc(fn, args = {}, { auth = true } = {}) {
  const body = auth ? { p_token: token(), ...args } : args;
  let r;
  try {
    r = await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: CONFIG.supabaseKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('OFFLINE', 'Pas de connexion. Réessaie dans un instant.');
  }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const code = (data && (data.message || data.error)) || `HTTP_${r.status}`;
    throw new ApiError(code, ERRORS[code] || `Le serveur a refusé la demande (${code}).`);
  }
  return data;
}

export const api = {
  register: (tok, pseudo, emoji) => rpc('register', { p_token: tok, p_pseudo: pseudo, p_emoji: emoji }, { auth: false }),
  whoami: (tok) => rpc('whoami', { p_token: tok }, { auth: false }),
  updateProfile: (pseudo, emoji) => rpc('update_profile', { p_pseudo: pseudo, p_emoji: emoji }),
  deleteAccount: () => rpc('delete_account'),
  createBand: (name) => rpc('create_band', { p_name: name }),
  joinBand: (code) => rpc('join_band', { p_code: code }),
  leaveBand: (id) => rpc('leave_band', { p_band_id: id }),
  saveAlarm: (a) => rpc('save_alarm', {
    p_id: a.id || null, p_time: a.time, p_days: a.days, p_enabled: a.enabled !== false,
    p_label: a.label || '', p_sound: a.sound, p_challenge: a.challenge, p_tz: a.tz,
  }),
  deleteAlarm: (id) => rpc('delete_alarm', { p_id: id }),
  state: () => rpc('get_state'),
  voice: (id) => rpc('get_voice', { p_wakeup_id: id }),
  sendWakeup: (w) => rpc('send_wakeup', {
    p_target: w.target, p_kind: w.kind, p_alarm_id: w.alarmId || null, p_fire_at: w.fireAt,
    p_sound: w.sound, p_message: w.message || '', p_voice: w.voice || null, p_challenge: w.challenge,
    p_weekly: w.weekly || null,
  }),
  cancelWakeup: (id) => rpc('cancel_wakeup', { p_id: id }),
  reportRing: (r) => rpc('report_ring', {
    p_wakeup_ids: r.wakeupIds, p_alarm_id: r.alarmId || null, p_action: r.action,
    p_seconds: r.seconds || 0, p_snoozes: r.snoozes || 0, p_fire_at: r.fireAt, p_snooze_minutes: r.snoozeMinutes || 5,
  }),
  react: (target, emoji) => rpc('send_reaction', { p_target: target, p_emoji: emoji }),
  feed: () => rpc('get_feed'),
  savePush: (sub) => rpc('save_push_sub', { p_endpoint: sub.endpoint, p_p256dh: sub.keys.p256dh, p_auth: sub.keys.auth }),
  deletePush: (endpoint) => rpc('delete_push_sub', { p_endpoint: endpoint }),
  testPush: () => rpc('request_test_push'),
};
