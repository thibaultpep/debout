// Catalogue : sons, défis, surprises de la semaine, avatars.
import { isoWeek } from './util.js';

export const SOUNDS = [
  { id: 'classique', name: 'Bip bip', emoji: '⏰' },
  { id: 'sirene', name: 'Sirène', emoji: '🚨' },
  { id: 'klaxon', name: 'Klaxon', emoji: '📯' },
  { id: 'fanfare', name: 'Fanfare', emoji: '🎺' },
  { id: 'ecole', name: "Sonnerie d'école", emoji: '🔔' },
  { id: 'chiptune', name: '8-bit', emoji: '👾' },
  { id: 'recul', name: 'Camion qui recule', emoji: '🚚' },
  { id: 'coucou', name: 'Coucou', emoji: '🐦' },
  { id: 'laser', name: 'Laser', emoji: '⚡' },
  { id: 'sonar', name: 'Sonar', emoji: '📡' },
  { id: 'gong', name: 'Gong', emoji: '🛎️' },
  { id: 'carillon', name: 'Carillon doux', emoji: '🎐' },
];

// Sons exclusifs, débloqués une semaine à la fois
export const WEEKLY_SOUNDS = [
  { id: 'decollage', name: 'Décollage', emoji: '🚀' },
  { id: 'disco', name: 'Disco', emoji: '🪩' },
  { id: 'kazoo', name: 'Kazoo', emoji: '🎉' },
  { id: 'alerte', name: 'Alerte rouge', emoji: '☢️' },
  { id: 'stade', name: 'Stade en folie', emoji: '🏟️' },
  { id: 'tambours', name: 'Tambours', emoji: '🥁' },
  { id: 'microondes', name: 'Micro-ondes', emoji: '🍿' },
  { id: 'boite', name: 'Boîte à musique', emoji: '🎠' },
];

export const ALL_SOUNDS = [...SOUNDS, ...WEEKLY_SOUNDS];
export const soundById = (id) => ALL_SOUNDS.find((s) => s.id === id) || SOUNDS[0];
export const soundUrl = (id) => `sounds/${soundById(id).id}.mp3`;

export const CHALLENGES = [
  { id: 'none', name: 'Aucun', emoji: '🙅', desc: 'Un bouton et c\'est coupé' },
  { id: 'taps', name: 'Taper 40 fois', emoji: '👆', desc: 'Taper 40 fois sur le bouton' },
  { id: 'maths', name: '3 calculs', emoji: '🧮', desc: 'Résoudre 3 calculs' },
  { id: 'phrase', name: 'Recopier une phrase', emoji: '✍️', desc: 'Recopier une phrase sans faute' },
  { id: 'hold', name: 'Tenir 8 secondes', emoji: '✋', desc: 'Garder le doigt appuyé 8 secondes' },
  { id: 'memory', name: 'Mémoire', emoji: '🧠', desc: 'Retenir une suite de 5 couleurs' },
];
export const challengeById = (id) => CHALLENGES.find((c) => c.id === id) || CHALLENGES[0];

export const WEEKLY = [
  { id: 'decollage', name: 'Le décollage', emoji: '🚀', sound: 'decollage', challenge: 'memory', pitch: 'Un moteur de fusée qui monte, et une suite de couleurs à retenir pour le couper.' },
  { id: 'disco', name: 'Disco inferno', emoji: '🪩', sound: 'disco', challenge: 'taps', pitch: 'Boum boum à fond, et 40 tapes pour que ça s\'arrête.' },
  { id: 'kazoo', name: 'Kazoo d\'enfer', emoji: '🎉', sound: 'kazoo', challenge: 'phrase', pitch: 'Le kazoo le plus faux du monde, et une phrase à recopier les yeux collés.' },
  { id: 'alerte', name: 'Alerte rouge', emoji: '☢️', sound: 'alerte', challenge: 'maths', pitch: 'Une alarme de sous-marin, et trois calculs pour la faire taire.' },
  { id: 'stade', name: 'Stade en folie', emoji: '🏟️', sound: 'stade', challenge: 'hold', pitch: 'Une tribune entière dans la chambre, et 8 secondes de doigt appuyé.' },
  { id: 'tambours', name: 'Tambours de guerre', emoji: '🥁', sound: 'tambours', challenge: 'taps', pitch: 'Des tambours qui cognent, et 40 tapes pour en finir.' },
  { id: 'microondes', name: 'Le micro-ondes', emoji: '🍿', sound: 'microondes', challenge: 'maths', pitch: 'Ding ding ding, ton petit-déj est prêt. Trois calculs avant de le manger.' },
  { id: 'boite', name: 'Boîte à musique', emoji: '🎠', sound: 'boite', challenge: 'phrase', pitch: 'Tout doux… mais il faut recopier une phrase pour couper.' },
];

export function weeklySurprise(date = new Date()) {
  return WEEKLY[isoWeek(date) % WEEKLY.length];
}
export const weeklyById = (id) => WEEKLY.find((w) => w.id === id);

export const AVATARS = ['🦊', '🐸', '🐻', '🐼', '🐨', '🦁', '🐯', '🐷', '🐵', '🦄', '🐙', '🦖', '🐔', '🦉', '🐧', '🐢', '🦥', '🐌', '👽', '🤖', '👻', '🤠', '🥷', '🧛'];

export const REACTIONS = ['😂', '😡', '🫡', '💀', '❤️', '🥱'];

export const PHRASES = [
  'je suis debout et je suis fier',
  'plus jamais je ne snooze',
  'mes potes sont les meilleurs',
  'le café ne va pas se faire tout seul',
  'je me lève comme un champion',
  'la marmotte, c\'est fini',
];
