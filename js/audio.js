// Audio : lecteur principal « débloqué », aperçus, enregistrement des vocaux,
// et maintien de l'écran allumé.
import { soundUrl } from './data.js';

// --- Lecteur principal --------------------------------------------------------
// Sur iPhone, un son ne peut démarrer tout seul que si l'élément audio a déjà été
// lancé par un geste de l'utilisateur. On garde donc UN élément, débloqué au premier
// tap (puis entretenu avec du silence en boucle pendant le mode dodo).
const player = new Audio();
player.preload = 'auto';
player.setAttribute('playsinline', '');
let unlocked = false;
let playlist = null;

// À appeler pendant un tap. keep = true : on laisse tourner le silence (mode dodo).
export function unlockAudio({ keep = false } = {}) {
  if (playlist) return Promise.resolve(true);
  if (unlocked && !keep) return Promise.resolve(true);
  player.onended = null;
  player.src = 'sounds/silence.mp3';
  player.loop = true;
  return player.play().then(() => {
    unlocked = true;
    if (!keep) player.pause();
    return true;
  }).catch(() => false);
}
export const isAudioUnlocked = () => unlocked;

export function keepAlive() {
  playlist = null;
  player.onended = null;
  player.src = 'sounds/silence.mp3';
  player.loop = true;
  return player.play().catch(() => {});
}

// Sons gardés en mémoire (mode dodo) : la sonnerie marche même si le réseau tombe
const blobs = new Map();
export async function preloadSounds(ids) {
  for (const id of new Set(ids)) {
    if (blobs.has(id)) continue;
    try {
      const r = await fetch(soundUrl(id));
      if (r.ok) blobs.set(id, URL.createObjectURL(await r.blob()));
    } catch { /* on réessaiera */ }
  }
}
const srcFor = (id) => blobs.get(id) || soundUrl(id);

// Joue en boucle : le son, puis chaque vocal, puis le son… jusqu'à stopRinging()
export function startRinging(sound, voices = []) {
  const items = [{ src: srcFor(sound), rounds: voices.length ? 1 : Infinity }, ...voices.map((v) => ({ src: v, rounds: 1 }))];
  playlist = { items, i: 0 };
  return playItem();
}

function playItem() {
  if (!playlist) return Promise.resolve(false);
  const it = playlist.items[playlist.i];
  player.loop = playlist.items.length === 1;
  player.src = it.src;
  player.currentTime = 0;
  player.onended = () => {
    if (!playlist) return;
    playlist.i = (playlist.i + 1) % playlist.items.length;
    playItem();
  };
  return player.play().then(() => { unlocked = true; return true; }).catch(() => false);
}

export function stopRinging({ keepSession = false } = {}) {
  playlist = null;
  player.onended = null;
  if (keepSession) keepAlive();
  else player.pause();
}

// --- Aperçus (choix d'un son) --------------------------------------------------
const preview = new Audio();
preview.setAttribute('playsinline', '');
let previewTimer;
export function previewSound(srcOrId, maxMs = 4000) {
  clearTimeout(previewTimer);
  preview.src = srcOrId.startsWith('data:') || srcOrId.includes('/') ? srcOrId : soundUrl(srcOrId);
  preview.currentTime = 0;
  preview.play().catch(() => {});
  if (maxMs) previewTimer = setTimeout(() => preview.pause(), maxMs);
}
export function stopPreview() { clearTimeout(previewTimer); preview.pause(); }

// --- Vibration (Android) -------------------------------------------------------
let vibTimer;
export function startVibrate() {
  if (!navigator.vibrate) return;
  clearInterval(vibTimer); // jamais deux boucles de vibration en même temps
  const go = () => navigator.vibrate([700, 300, 700, 300, 700]);
  go();
  vibTimer = setInterval(go, 3200);
}
export function stopVibrate() { clearInterval(vibTimer); if (navigator.vibrate) navigator.vibrate(0); }

// --- Enregistrement des vocaux -------------------------------------------------
// On enregistre avec le format natif du téléphone, puis on convertit en WAV 16 kHz :
// lisible partout, iPhone comme Android.
export const MAX_VOICE_S = 12;

export function canRecord() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported?.(m));
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((resolve, reject) => {
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
        resolve(await blobToWavDataUrl(blob));
      } catch (e) { reject(e); }
    };
  });
  rec.start(250);
  const timer = setTimeout(() => rec.state !== 'inactive' && rec.stop(), MAX_VOICE_S * 1000);
  return {
    stop() { clearTimeout(timer); if (rec.state !== 'inactive') rec.stop(); return done; },
    done,
  };
}

async function blobToWavDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const decoded = await new Promise((res, rej) => ctx.decodeAudioData(buf.slice(0), res, rej));
  ctx.close?.();
  const rate = 16000;
  const len = Math.min(Math.ceil(decoded.duration * rate), MAX_VOICE_S * rate);
  const off = new OfflineAudioContext(1, Math.max(1, len), rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  const data = rendered.getChannelData(0);
  // normalisation : un vocal de réveil doit s'entendre
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  const gain = peak > 0.01 ? Math.min(8, 0.95 / peak) : 1;
  const pcm = new DataView(new ArrayBuffer(44 + data.length * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) pcm.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); pcm.setUint32(4, 36 + data.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  pcm.setUint32(16, 16, true); pcm.setUint16(20, 1, true); pcm.setUint16(22, 1, true);
  pcm.setUint32(24, rate, true); pcm.setUint32(28, rate * 2, true); pcm.setUint16(32, 2, true);
  pcm.setUint16(34, 16, true); w(36, 'data'); pcm.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) {
    const v = Math.max(-1, Math.min(1, data[i] * gain));
    pcm.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { dataUrl: 'data:audio/wav;base64,' + btoa(bin), seconds: data.length / rate };
}

// --- Écran allumé --------------------------------------------------------------
let wakeLock = null;
let video = null;
export async function keepScreenOn() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => { wakeLock = null; });
      return 'wakelock';
    }
  } catch { /* on passe au plan B */ }
  // plan B : une minuscule vidéo muette en boucle empêche la mise en veille
  if (!video) {
    video = document.createElement('video');
    Object.assign(video, { muted: true, loop: true, playsInline: true, src: 'nosleep.mp4' });
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;bottom:0;left:0';
    document.body.append(video);
  }
  try { await video.play(); return 'video'; } catch { return 'none'; }
}
export function releaseScreen() {
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  video?.pause();
}
export const hasWakeLock = () => !!wakeLock;
