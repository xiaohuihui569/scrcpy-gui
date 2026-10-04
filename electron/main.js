'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const adb = require('./adb');
const {
  ProfileStore, NameStore, normalize, diffRequiresRestart, DEFAULT_PROFILE,
} = require('./profile');
const { SessionManager } = require('./scrcpy');

const POLL_INTERVAL_MS = 3000;
const DEV = process.argv.includes('--dev');

let mainWindow = null;
let store = null;
let names = null;
let prefs = null;
let manager = null;
let pollTimer = null;

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#16181d',
    show: false,
    title: 'scrcpy GUI',
    autoHideMenuBar: true,
    icon: fs.existsSync(adb.binPath('scrcpy.png'))
      ? adb.binPath('scrcpy.png')
      : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ------------------------------------------------------------------ */
/* Device polling                                                      */
/* ------------------------------------------------------------------ */

const deviceInfoCache = new Map(); // serial -> { at, info }
let lastDevicesHash = '';

// Reading the phone Wi-Fi address costs one extra shell round-trip, and the
// device list is polled every 3s. Cache it for a while so the poll stays cheap.
// The "re-detect" button drops the entry to force an immediate re-read.
const INFO_TTL_MS = 15000;

function cachedInfo(serial) {
  const hit = deviceInfoCache.get(serial);
  if (!hit || Date.now() - hit.at > INFO_TTL_MS) return null;
  return hit.info;
}

async function collectDevices() {
  const res = await adb.listDevices();
  if (!res.ok) {
    return { ok: false, devices: [], error: friendlyAdbError(res.error) };
  }

  const online = res.devices.filter((d) => d.state === 'device');
  await Promise.all(online.map(async (d) => {
    if (cachedInfo(d.serial)) return;
    const info = await adb.getDeviceInfo(d.serial).catch(() => null);
    if (info) deviceInfoCache.set(d.serial, { at: Date.now(), info });
  }));

  return {
    ok: true,
    error: null,
    devices: res.devices.map((d) => ({
      ...d,
      info: cachedInfo(d.serial) || null,
      customName: names ? names.get(nameKeyOf(d)) : '',
    })),
  };
}

/**
 * Storage key for a device name: the model identifies the physical phone.
 * product is a second-best proxy; the serial is the last resort.
 */
function nameKeyOf(d) {
  return d.model || d.product || d.serial || '';
}

/** Custom device names are a display label, so they stay short. */
const MAX_NAME_LENGTH = 24;

class Prefs {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {};
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') this.data = parsed;
    } catch {
      this.data = {};
    }
    return this.data;
  }

  get(key, fallback = null) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    this.flush();
  }

  /** Written immediately: these flags are rare and tiny. */
  flush() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[prefs] failed to persist preferences:', err);
    }
  }
}

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/** Reject 999.1.1.1 and friends: each octet must fit in a byte. */
function isValidIpv4(ip) {
  if (!IPV4_RE.test(ip)) return false;
  return ip.split('.').every((part) => Number(part) <= 255);
}
const DEFAULT_TCPIP_PORT = 5555;

/**
 * Accept either a legacy "ip:port" string or a structured { ip, port }
 * payload from the UI, and return a validated "ip:port" target.
 */
function parseTarget(payload) {
  let ip = '';
  let port = DEFAULT_TCPIP_PORT;

  if (payload && typeof payload === 'object') {
    ip = String(payload.ip || '').trim();
    if (payload.port !== undefined && String(payload.port).trim() !== '') {
      port = String(payload.port).trim();
    }
  } else {
    ip = String(payload || '').trim();
  }

  // Tolerate "1.2.3.4:5555" typed into the IP box.
  const inline = /^(.*?):(\d{1,5})$/.exec(ip);
  if (inline) {
    ip = inline[1];
    port = inline[2];
  }

  if (!ip) return { value: '', error: '请输入 IP 地址。' };
  if (!isValidIpv4(ip)) return { value: '', error: 'IP 地址格式不正确，请检查输入框。' };

  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return { value: '', port: DEFAULT_TCPIP_PORT, error: '端口号无效，请填写 1-65535 之间的数字。' };
  }

  return { value: `${ip}:${portNum}`, port: portNum, error: null };
}

/** Small delay helper: some adb flows need a beat before the next call. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Custom name for a serial, resolved through the model so it survives an
 * IP change. Uses adb.listDevices() directly: this runs on the launch path,
 * where the extra per-device shell calls of collectDevices() would be waste.
 */
async function deviceNameFor(serial) {
  if (!names) return '';
  const res = await adb.listDevices();
  if (!res.ok) return '';
  const dev = res.devices.find((d) => d.serial === serial);
  return dev ? names.get(nameKeyOf(dev)) : '';
}

/**
 * Use the custom device name as the scrcpy window title when the user has not
 * typed one. Applied only to the profile handed to the launcher: persisting
 * it would freeze today's name into profiles.json and silently win over a
 * later rename.
 */
async function withDeviceName(serial, profile) {
  const name = await deviceNameFor(serial);
  const p = normalize(profile);
  if (!name || p.windowTitle) return p;
  return { ...p, windowTitle: name };
}

/** Turn raw adb stderr into something a user can act on. */
function friendlyAdbError(raw, target) {
  const text = String(raw || '');

  // Daemon-level problems first: they would otherwise be swallowed by the
  // generic "connection refused" match below.
  if (/cannot connect to daemon|connection refused|cannot bind/i.test(text)) {
    return '无法连接 ADB 服务，请确认没有其他程序（如 Android Studio）占用。';
  }
  if (/Cannot mkdir/i.test(text) || /\.android/i.test(text)) {
    return 'ADB 无法创建 %USERPROFILE%\\.android 目录，请检查该目录的写入权限。';
  }
  if (/no devices\/emulators found/i.test(text)) {
    return '未检测到设备。';
  }
  if (/cannot assign requested address|timed? ?out|no route to host/i.test(text)) {
    return 'IP 已失效（手机可能换了网络或已离线），请点刷新按钮重新获取。';
  }
  if (/failed to connect|\beconnrefused\b|unable to connect to/i.test(text)) {
    return '连接失败：请确认手机与本机在同一 Wi-Fi，且 IP 与端口正确。';
  }
  // "adb tcpip" reports bad arguments on stdout, not stderr.
  if (/invalid port|usage:|unknown command/i.test(text)) {
    return '开启网络调试失败：ADB 拒绝了端口参数。';
  }
  if (/device .* not found|\bno devices\/emulators found\b/i.test(text)) {
    return '选中的设备已离线，请重新选择后再试。';
  }
  const line = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
  return (target ? `连接 ${target} 失败：` : '') + (line || 'ADB 调用失败。');
}

async function pollDevices() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Only poll while the window is visible, to avoid needless adb traffic.
  if (!mainWindow.isVisible()) return;

  const res = await collectDevices();
  const hash = JSON.stringify(res.devices.map((d) => [d.serial, d.state, d.model]));
  const changed = hash !== lastDevicesHash;
  lastDevicesHash = hash;
  send('devices:update', { ...res, changed });
}

/* ------------------------------------------------------------------ */
/* IPC helpers                                                         */
/* ------------------------------------------------------------------ */

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/* ------------------------------------------------------------------ */
/* IPC handlers                                                        */
/* ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle('app:info', async () => {
    const integrity = adb.checkIntegrity();
    return {
      resourceDir: adb.resourceDir(),
      integrity,
      version: app.getVersion(),
      packaged: app.isPackaged,
      defaultProfile: normalize(DEFAULT_PROFILE),
      names: names ? names.all() : {},
      tutorialSuppressed: prefs ? !!prefs.get('tutorialSeen', false) : false,
      showTutorial: prefs ? !prefs.get('tutorialSeen', false) : true,
    };
  });

  ipcMain.handle('devices:list', async () => collectDevices());

  ipcMain.handle('devices:refresh', async () => {
    lastDevicesHash = ''; // force a change notification
    await pollDevices();
    return collectDevices();
  });

  // Drop the cached Wi-Fi IP so the next poll re-reads it from the device.
  ipcMain.handle('devices:ip:invalidate', async (serial) => {
    if (serial) deviceInfoCache.delete(String(serial));
  });

  ipcMain.handle('devices:tcpip', async (_e, payload) => {
    const { value, error, port } = parseTarget(payload);
    if (!value) return { ok: false, error };

    // Which phone switches to network mode? The one selected in the list.
    const serial = payload && typeof payload === 'object' ? String(payload.serial || '').trim() : '';
    if (!serial) return { ok: false, error: '请先在左侧选择要开启网络调试的设备。' };
    const known = (await collectDevices()).devices.some((d) => d.serial === serial);
    if (!known) return { ok: false, error: '选中的设备已离线，请重新选择后再试。' };

    // adb tcpip only accepts a port number -- never "ip:port".
    const res = await adb.tcpip(serial, port);
    if (res.code !== 0) return { ok: false, error: friendlyAdbError(res.stderr || res.stdout) };
    if (/invalid port|usage:|unknown command/i.test(String(res.stdout || '') + String(res.stderr || ''))) {
      return { ok: false, error: '开启网络调试失败：ADB 拒绝了端口参数。' };
    }

    // The phone restarts its adbd daemon; connecting too early fails.
    await sleep(1500);
    const conn = await adb.connect(value);
    if (!conn.ok) return { ok: false, error: friendlyAdbError(conn.error || conn.stderr, value) };

    // Make the new wireless entry show up right away.
    lastDevicesHash = '';
    await pollDevices();
    return { ok: true, target: value };
  });

  ipcMain.handle('devices:connect', async (_e, payload) => {
    const { value, error } = parseTarget(payload);
    if (!value) return { ok: false, error };
    const res = await adb.connect(value);
    if (!res.ok) return { ok: false, error: friendlyAdbError(res.error || res.stderr, value) };
    lastDevicesHash = '';
    await pollDevices();
    return { ok: true, target: value };
  });

  ipcMain.handle('tutorial:seen', async (_e, suppressed) => {
    // `suppressed` is the checkbox state: true = stop auto-showing.
    if (prefs) prefs.set('tutorialSeen', !!suppressed);
    return { ok: true, suppressed: !!suppressed };
  });

  ipcMain.handle('tutorial:reset', async () => {
    if (prefs) prefs.set('tutorialSeen', false);
    return { ok: true };
  });

  ipcMain.handle('device:name:get', async () => names.all());

  ipcMain.handle('device:name:set', async (_e, model, name) => {
    const clean = String(name || '').trim();
    if (clean.length > MAX_NAME_LENGTH) {
      return { ok: false, error: `名称最长 ${MAX_NAME_LENGTH} 个字符，请缩短。` };
    }
    if (!names.set(model, clean)) {
      return { ok: false, error: '无法确定设备型号，请刷新后重试。' };
    }
    const table = names.all();
    send('device:names', table);
    return { ok: true, names: table };
  });

  ipcMain.handle('profile:get', async (_e, serial) => store.get(serial));

  ipcMain.handle('profile:default:get', async () => store.get(null));

  ipcMain.handle('profile:default:set', async (_e, profile) => store.set(null, profile));

  ipcMain.handle('profile:set', async (_e, serial, profile) => {
    const saved = store.set(serial, profile);
    const live = manager.stateOf(serial);
    manager.updateProfile(serial, saved);
    send('profile:dirty', {
      serial,
      running: !!(live && (live.state === 'running' || live.state === 'starting')),
      needsRestart: manager.needsRestart(serial, saved),
    });
    return saved;
  });

  ipcMain.handle('profile:diff', async (_e, serial, profile) => ({
    changed: diffRequiresRestart(store.get(serial), normalize(profile)),
    needsRestart: manager.needsRestart(serial, profile),
  }));

  ipcMain.handle('session:start', async (_e, serial, profile) => {
    const saved = store.set(serial, profile);
    const res = await manager.start(serial, await withDeviceName(serial, saved));
    send('session:states', manager.allStates());
    return res;
  });

  ipcMain.handle('session:stop', async (_e, serial) => {
    const res = await manager.stop(serial);
    send('session:states', manager.allStates());
    return res;
  });

  ipcMain.handle('session:restart', async (_e, serial, profile) => {
    const saved = store.set(serial, profile);
    const res = await manager.restart(serial, await withDeviceName(serial, saved));
    send('session:states', manager.allStates());
    return res;
  });

  ipcMain.handle('session:state', async (_e, serial) => manager.stateOf(serial));

  ipcMain.handle('session:states', async () => manager.allStates());

  ipcMain.handle('session:logs', async (_e, serial) => manager.logsOf(serial));

  ipcMain.handle('key:send', async (_e, serial, code) => {
    const res = await adb.keyevent(serial, code);
    return { ok: res.code === 0, error: res.code === 0 ? null : friendlyAdbError(res.stderr) };
  });

  ipcMain.handle('device:immersive', async (_e, serial, enable) => {
    const res = await adb.immersive(serial, enable);
    return { ok: res.code === 0, error: res.code === 0 ? null : friendlyAdbError(res.stderr) };
  });

  ipcMain.handle('device:screenshot', async (_e, serial) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const candidates = [
      path.join(os.homedir(), 'Pictures', 'scrcpy-gui'),
      path.join(os.homedir(), 'Desktop'),
      os.tmpdir(),
    ];
    let dir = candidates[0];
    for (const d of candidates) {
      try {
        fs.mkdirSync(d, { recursive: true });
        fs.accessSync(d, fs.constants.W_OK);
        dir = d;
        break;
      } catch {
        // try the next candidate
      }
    }
    const file = path.join(dir, `screenshot-${stamp}.png`);
    const res = await adb.screenshot(serial, file);
    if (res.ok) shell.showItemInFolder(res.file);
    return res;
  });

  ipcMain.handle('shell:openPath', async (_e, p) => shell.openPath(p));

  ipcMain.handle('shell:openFolder', async (_e, p) => {
    const r = await shell.openPath(p);
    return { ok: !r, error: r || null };
  });

  ipcMain.handle('dialog:confirm', async (e, { title, message, detail }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['取消', '确定'],
      defaultId: 1,
      cancelId: 0,
      title: title || '确认',
      message: message || '',
      detail: detail || '',
      noLink: true,
    });
    return res.response === 1;
  });

  ipcMain.handle('dialog:message', async (e, { type, title, message, detail }) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    await dialog.showMessageBox(win, {
      type: type || 'info',
      buttons: ['好'],
      title: title || '提示',
      message: message || '',
      detail: detail || '',
      noLink: true,
    });
    return true;
  });

  ipcMain.handle('app:relaunch', async () => {
    await manager.stopAll();
    app.relaunch();
    app.exit(0);
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* Bootstrap                                                           */
/* ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  const integrity = adb.checkIntegrity();
  if (!integrity.ok) {
    dialog.showMessageBoxSync({
      type: 'error',
      title: '缺少 scrcpy 组件',
      message: '未找到完整的 scrcpy 运行文件。',
      detail: `缺少: ${integrity.missing.join(', ')}\n\n期望目录: ${integrity.dir}`,
      buttons: ['确定'],
    });
  }

  store = new ProfileStore(path.join(app.getPath('userData'), 'profiles.json'));
  names = new NameStore(path.join(app.getPath('userData'), 'names.json'));
  prefs = new Prefs(path.join(app.getPath('userData'), 'prefs.json'));
  manager = new SessionManager();

  manager.on('log', (entry, serial) => send('session:log', { serial, entry }));
  manager.on('state', (snap) => send('session:state', { serial: snap.serial, state: snap, states: manager.allStates() }));
  manager.on('exit', (snap) => send('session:exit', { serial: snap.serial, state: snap, states: manager.allStates() }));

  registerIpc();
  createWindow();

  await adb.startServer();
  pollDevices();
  pollTimer = setInterval(pollDevices, POLL_INTERVAL_MS);
});

app.on('window-all-closed', async () => {
  if (pollTimer) clearInterval(pollTimer);
  if (manager) await manager.stopAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  if (pollTimer) clearInterval(pollTimer);
  if (store) store.flush();
  if (names) names.flush();
  if (manager) await manager.stopAll();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
