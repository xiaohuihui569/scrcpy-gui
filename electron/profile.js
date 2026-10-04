'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Default mirror parameters. Every field here maps to a scrcpy CLI option,
 * so this doubles as the "shape" of a persisted profile.
 */
const DEFAULT_PROFILE = {
  maxSize: 0,            // 0 = device native resolution
  videoBitRate: 0,       // 0 = scrcpy default (8M)
  maxFps: 0,             // 0 = unlimited
  videoCodec: '',
  audioCodec: '',
  renderFit: '',         // '' | letterbox | stretched | unscaled
  orientation: '',       // '' | 0 | 90 | 180 | 270
  captureOrientation: '',
  windowTitle: '',       // '' = auto ("<model> - scrcpy")
  windowWidth: 0,
  windowHeight: 0,
  windowX: '',
  windowY: '',
  alwaysOnTop: false,
  fullscreen: false,
  windowBorderless: false,
  stayAwake: true,
  powerOffOnClose: false,
  killAdbOnClose: false,
  disableScreensaver: true,
  showTouches: false,
  noAudio: false,
  noVideo: false,
  noControl: false,
  noClipboardAutosync: false,
  noMipmaps: false,
  renderDriver: '',      // '' | direct3d | opengl | opengles2 | vulkan
  keyboardMode: '',      // '' | disabled | sdk | uhid | aoa
  mouseMode: '',         // '' | disabled | sdk | uhid | aoa
  gamepadMode: '',       // '' | disabled | uhid | aoa
  forceAdbForward: false,
  turnScreenOff: false,
  legacyPaste: false,
  preferText: false,
  angle: '',             // custom rotation in degrees
  recordPath: '',        // '' = no recording
  recordFormat: '',
  timeLimit: 0,          // seconds, 0 = unlimited
  tcpip: '',             // '' or host[:port]
  extraArgs: '',         // free-form passthrough
};

/** Options that only take effect after the mirror process restarts. */
const RESTART_REQUIRED_KEYS = [
  'maxSize', 'videoBitRate', 'maxFps', 'videoCodec', 'audioCodec',
  'renderFit', 'orientation', 'captureOrientation', 'windowTitle',
  'windowWidth', 'windowHeight', 'windowX', 'windowY', 'alwaysOnTop',
  'fullscreen', 'windowBorderless', 'noAudio', 'noVideo', 'noControl',
  'noClipboardAutosync', 'noMipmaps', 'renderDriver', 'keyboardMode',
  'mouseMode', 'gamepadMode', 'forceAdbForward', 'turnScreenOff',
  'legacyPaste', 'preferText', 'angle', 'recordPath', 'recordFormat',
  'timeLimit', 'extraArgs',
];

const FLAG_KEYS = [
  'alwaysOnTop', 'fullscreen', 'windowBorderless', 'stayAwake',
  'powerOffOnClose', 'killAdbOnClose', 'disableScreensaver', 'showTouches',
  'noAudio', 'noVideo', 'noControl', 'noClipboardAutosync', 'noMipmaps',
  'forceAdbForward', 'turnScreenOff', 'legacyPaste', 'preferText',
];

const OPTION_KEYS = {
  maxSize: '--max-size',
  videoBitRate: '--video-bit-rate',
  maxFps: '--max-fps',
  videoCodec: '--video-codec',
  audioCodec: '--audio-codec',
  renderFit: '--render-fit',
  orientation: '--orientation',
  captureOrientation: '--capture-orientation',
  windowTitle: '--window-title',
  windowWidth: '--window-width',
  windowHeight: '--window-height',
  windowX: '--window-x',
  windowY: '--window-y',
  renderDriver: '--render-driver',
  keyboardMode: '--keyboard',
  mouseMode: '--mouse',
  gamepadMode: '--gamepad',
  angle: '--angle',
  recordFormat: '--record-format',
  timeLimit: '--time-limit',
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function normalize(input) {
  const out = clone(DEFAULT_PROFILE);
  if (input && typeof input === 'object') {
    for (const key of Object.keys(DEFAULT_PROFILE)) {
      if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = input[key];
    }
  }
  // Coerce numeric fields so bad persisted data can never break arg building.
  // NOTE: videoBitRate is deliberately excluded -- it accepts unit suffixes
  // like "8M" or "10000K", so it stays a string.
  for (const key of ['maxSize', 'maxFps', 'windowWidth',
    'windowHeight', 'timeLimit']) {
    const n = Number(out[key]);
    out[key] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  if (out.videoBitRate === 0 || out.videoBitRate === null || out.videoBitRate === undefined) {
    out.videoBitRate = '';
  } else {
    out.videoBitRate = String(out.videoBitRate).trim();
  }
  for (const key of FLAG_KEYS) out[key] = Boolean(out[key]);
  for (const key of Object.keys(out)) {
    if (typeof out[key] !== 'boolean' && typeof out[key] !== 'number') {
      out[key] = out[key] === null || out[key] === undefined ? '' : String(out[key]);
    }
  }
  return out;
}

/**
 * Translate a profile into a scrcpy argument array.
 * This is the single place where GUI settings become CLI flags, so the UI
 * never has to know scrcpy's exact spelling.
 */
function buildArgs(serial, profile) {
  const p = normalize(profile);
  const args = ['-s', serial];

  for (const key of FLAG_KEYS) {
    if (p[key]) args.push(`--${dashed(key)}`);
  }

  for (const [key, flag] of Object.entries(OPTION_KEYS)) {
    const value = p[key];
    if (value === 0 || value === '' || value === null) continue;
    args.push(`${flag}=${value}`);
  }

  if (p.recordPath) args.push(`--record=${p.recordPath}`);

  // tcpip mode: target the device over the network instead of USB.
  if (p.tcpip) args.push(`--tcpip=${p.tcpip}`);

  if (p.extraArgs && p.extraArgs.trim()) {
    // Split on whitespace but honour simple double-quoted segments.
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(p.extraArgs)) !== null) {
      args.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
    }
  }

  return args;
}

function dashed(key) {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Compare two profiles on the fields that need a restart to take effect. */
function diffRequiresRestart(oldProfile, newProfile) {
  const a = normalize(oldProfile);
  const b = normalize(newProfile);
  const changed = [];
  for (const key of RESTART_REQUIRED_KEYS) {
    if (a[key] !== b[key]) changed.push(key);
  }
  return changed;
}

/** Persisted profile store: { "<serial>": Profile, "__default__": Profile } */
class ProfileStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {};
    this.writeTimer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) this.data[k] = normalize(v);
      }
    } catch {
      this.data = {};
    }
    if (!this.data.__default__) this.data.__default__ = normalize(DEFAULT_PROFILE);
    return this.data;
  }

  get(serial) {
    if (serial && this.data[serial]) return clone(this.data[serial]);
    return clone(this.data.__default__ || normalize(DEFAULT_PROFILE));
  }

  set(serial, profile) {
    const key = serial || '__default__';
    this.data[key] = normalize(profile);
    this.scheduleWrite();
    return clone(this.data[key]);
  }

  /** Remember which profile belongs to which physical device model. */
  getByModel(model) {
    if (!model) return this.get(null);
    const key = `__model__:${model.toLowerCase()}`;
    if (this.data[key]) return clone(this.data[key]);
    return this.get(null);
  }

  setByModel(model, profile) {
    if (!model) return this.get(null);
    const key = `__model__:${model.toLowerCase()}`;
    this.data[key] = normalize(profile);
    this.scheduleWrite();
    return clone(this.data[key]);
  }

  scheduleWrite() {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => this.flush(), 300);
  }

  /** Atomic write: temp file then rename, so a crash never truncates config. */
  flush() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[profile] failed to persist profiles:', err);
    }
  }

  all() {
    const out = {};
    for (const [k, v] of Object.entries(this.data)) out[k] = clone(v);
    return out;
  }
}

/**
 * Custom, user-given device names, persisted separately from mirror profiles.
 *
 * Names are keyed by MODEL rather than serial on purpose: a wireless device
 * shows up as "192.168.1.37:5555", and that address changes the moment the
 * phone rejoins a different network or the router hands out a new lease. Keying
 * on the model means the name survives IP changes and USB/wireless switches.
 *
 * Trade-off (accepted): two phones of the same model share one name.
 *
 * File format: { "<lowercased model>": "<display name>" }
 */
class NameStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {};
    this.writeTimer = null;
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && v.trim()) this.data[k] = v.trim();
        }
      }
    } catch {
      this.data = {};
    }
    return this.data;
  }

  /** Normalize a model/product/serial into the storage key. */
  static key(model) {
    return String(model || '').trim().toLowerCase();
  }

  get(model) {
    const k = NameStore.key(model);
    return (k && this.data[k]) || '';
  }

  /** An empty name removes the entry, so the device falls back to its model. */
  set(model, name) {
    const k = NameStore.key(model);
    if (!k) return false;
    const v = String(name || '').trim();
    if (v) this.data[k] = v;
    else delete this.data[k];
    this.scheduleWrite();
    return true;
  }

  scheduleWrite() {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => this.flush(), 300);
  }

  /** Atomic write: temp file then rename, so a crash never truncates config. */
  flush() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[names] failed to persist device names:', err);
    }
  }

  all() {
    return { ...this.data };
  }
}

module.exports = {
  DEFAULT_PROFILE,
  RESTART_REQUIRED_KEYS,
  normalize,
  buildArgs,
  diffRequiresRestart,
  ProfileStore,
  NameStore,
};

