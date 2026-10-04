'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// `app` only exists inside Electron. Resolve it lazily so this module can also
// be exercised from a plain Node process (tests / tooling).
let electronApp = null;
try {
  // eslint-disable-next-line global-require
  electronApp = require('electron').app || null;
} catch {
  electronApp = null;
}

/**
 * Resolve the directory that holds the bundled scrcpy/adb binaries.
 *
 * Several layouts are supported, checked in order:
 *  1. resources/scrcpy  -- electron-builder extraResources (packaged app)
 *  2. the .exe folder   -- "drop the unpacked app next to scrcpy" layout
 *  3. the project root  -- development / plain `node` invocation
 */
function resourceDir() {
  const candidates = [];
  if (electronApp && electronApp.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'scrcpy'));
    candidates.push(path.dirname(electronApp.getPath('exe')));
  }
  if (electronApp) candidates.push(electronApp.getAppPath());
  candidates.push(path.resolve(__dirname, '..'));

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'scrcpy.exe'))) return dir;
  }
  // Nothing found: return the most likely location so error messages point
  // somewhere sensible.
  return candidates[0] || path.resolve(__dirname, '..');
}

function binPath(name) {
  return path.join(resourceDir(), name);
}

/** Files that must exist for the app to be able to start scrcpy. */
function checkIntegrity() {
  const required = ['scrcpy.exe', 'scrcpy-server', 'adb.exe', 'SDL3.dll'];
  const missing = required.filter((f) => !fs.existsSync(binPath(f)));
  return { ok: missing.length === 0, missing, dir: resourceDir() };
}

/**
 * Run adb with the given args.
 * Resolves with { code, stdout, stderr } — never throws on non-zero exit,
 * so callers can decide how to surface a failure.
 */
function run(args, options = {}) {
  const { timeout = 15000 } = options;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binPath('adb.exe'), args, {
        cwd: resourceDir(),
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err && err.message) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        try { child.kill(); } catch { /* ignore */ }
      }
    }, timeout);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err && err.message) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, stdout, stderr });
    });
  });
}

/** Run adb against one specific serial. Always uses -s to avoid cross-talk. */
function runOn(serial, args, options) {
  return run(['-s', serial, ...args], options);
}

function startServer() {
  return run(['start-server'], { timeout: 20000 });
}

function killServer() {
  return run(['kill-server'], { timeout: 10000 });
}

/**
 * Switch a device to TCP/IP debugging mode.
 *
 * NOTE: "adb tcpip" takes a PORT NUMBER ONLY. Passing "ip:port" makes adb
 * fail with "invalid port", the phone never enables network debugging, and
 * the following adb connect can then never succeed -- which is why the
 * wireless device would never show up in the device list.
 * The serial is mandatory so a multi-device setup switches the right phone.
 */
function tcpip(serial, port) {
  return runOn(serial, ['tcpip', String(port)], { timeout: 20000 });
}

/**
 * Connect to a wireless device.
 *
 * "adb connect" ALWAYS exits with code 0, even when it fails; the real
 * result is printed on stdout ("connected to ..." / "failed to connect
 * to ..."). So success must be decided by parsing stdout, not the exit code.
 * Resolves with { ok, stdout, stderr, error? }.
 */
async function connect(ipPort) {
  const res = await run(['connect', ipPort], { timeout: 20000 });
  const out = String(res.stdout || '').trim();
  const errText = String(res.stderr || '').trim();
  const ok = res.code === 0 && /^(connected to|already connected to)\b/i.test(out);
  const error = ok ? null : (out || errText || 'ADB connect 调用失败。');
  return { ok, code: res.code, stdout: out, stderr: errText, error };
}

/* --- Wi-Fi IP discovery ---------------------------------------------
   TCP/IP debugging needs the phone address on the LAN. Every command below
   is pinned to the wlan0 interface on purpose: a plain "ip addr" also lists
   eth0 / usb0 / rndis addresses, and handing one of those to the user would
   produce an address the PC cannot reach.
   Resolves with { ip, iface: 'wlan0' } or null (Wi-Fi off, no address).
   Never throws: a failure here must not break the device list. */
const IPV4_RE = /(?:\d{1,3}\.){3}\d{1,3}/;

function parseWlanIp(stdout) {
  const m = /inet\s+(?:addr:)?((?:\d{1,3}\.){3}\d{1,3})/.exec(String(stdout || ''));
  return m ? m[1] : null;
}

async function getDeviceIp(serial) {
  const attempts = [
    [['shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'], parseWlanIp],
    [['shell', 'ifconfig', 'wlan0'], parseWlanIp],
    [['shell', 'getprop', 'dhcp.wlan0.ipaddress'], (out) => {
      const hit = IPV4_RE.exec(String(out || '').trim());
      return hit ? hit[0] : null;
    }],
  ];

  for (const [args, parse] of attempts) {
    let res;
    try {
      res = await runOn(serial, args, { timeout: 6000 });
    } catch {
      continue;
    }
    if (!res || res.code !== 0) continue;
    const ip = parse(res.stdout);
    if (ip) return { ip, iface: 'wlan0' };
  }
  return null;
}

/**
 * Parse `adb devices -l` output into structured records.
 * Returns [] on any failure (e.g. adb cannot write ~/.android) so the UI can
 * simply show the empty state instead of crashing.
 */
function parseDevices(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const devices = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('List of devices')) continue;
    if (line.startsWith('*')) continue; // daemon chatter
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const serial = parts[0];
    const state = parts[1];
    const info = {};
    for (const p of parts.slice(2)) {
      const idx = p.indexOf(':');
      if (idx > 0) info[p.slice(0, idx)] = p.slice(idx + 1);
    }
    devices.push({
      serial,
      state,
      model: (info.model || '').replace(/_/g, ' ') || null,
      product: info.product || null,
      device: info.device || null,
      transportId: info.transport_id || null,
    });
  }
  return devices;
}

async function listDevices() {
  const res = await run(['devices', '-l'], { timeout: 12000 });
  if (res.code !== 0) {
    return { ok: false, devices: [], error: res.stderr.trim() || `adb exited with code ${res.code}` };
  }
  return { ok: true, devices: parseDevices(res.stdout), error: null };
}

async function getProp(serial, prop) {
  const res = await runOn(serial, ['shell', 'getprop', prop], { timeout: 10000 });
  if (res.code !== 0) return null;
  const v = res.stdout.trim();
  return v.length ? v : null;
}

/** Fetch display metadata used in the device list subtitle. */
async function getDeviceInfo(serial) {
  const [model, androidRelease, sdk, size, battery, wifi] = await Promise.all([
    getProp(serial, 'ro.product.model'),
    getProp(serial, 'ro.build.version.release'),
    getProp(serial, 'ro.build.version.sdk'),
    getProp(serial, 'ro.build.version.display.id'),
    runOn(serial, ['shell', 'dumpsys', 'battery'], { timeout: 10000 }),
    getDeviceIp(serial),
  ]);

  let batteryLevel = null;
  const m = /level:\s*(\d+)/.exec(battery.stdout || '');
  if (m) batteryLevel = Number(m[1]);

  return {
    model,
    androidRelease,
    sdk,
    build: size,
    batteryLevel,
    wifiIp: wifi ? wifi.ip : null,
  };
}

function keyevent(serial, code) {
  return runOn(serial, ['shell', 'input', 'keyevent', String(code)], { timeout: 8000 });
}

function text(serial, value) {
  return runOn(serial, ['shell', 'input', 'text', value], { timeout: 8000 });
}

/** Toggle immersive (hide system bars) mode via policy_control. */
function immersive(serial, enable) {
  return runOn(serial, [
    'shell', 'settings', 'put', 'global', 'immersive.mode_confirmations', 'confirmed',
  ], { timeout: 8000 }).then(() => runOn(serial, [
    'shell', 'settings', 'put', 'global', 'policy_control',
    enable ? 'immersive.full=*' : 'null',
  ], { timeout: 8000 }));
}

/** Capture a screenshot straight from the device (no restart needed). */
function screenshot(serial, outFile) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binPath('adb.exe'), ['-s', serial, 'exec-out', 'screencap', '-p'], {
        cwd: resourceDir(),
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, error: String(err && err.message) });
      return;
    }
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('error', (err) => resolve({ ok: false, error: String(err && err.message) }));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: `adb screencap exited with code ${code}` });
        return;
      }
      const buf = Buffer.concat(chunks);
      if (buf.length < 8) {
        resolve({ ok: false, error: 'screencap returned no data' });
        return;
      }
      try {
        fs.writeFileSync(outFile, buf);
        resolve({ ok: true, file: outFile, size: buf.length });
      } catch (err) {
        resolve({ ok: false, error: String(err && err.message) });
      }
    });
  });
}

/** Turn the device screen off without terminating the scrcpy session. */
function screenOff(serial) {
  return keyevent(serial, 26);
}

module.exports = {
  resourceDir,
  binPath,
  checkIntegrity,
  run,
  runOn,
  startServer,
  killServer,
  tcpip,
  connect,
  getDeviceIp,
  listDevices,
  parseDevices,
  getProp,
  getDeviceInfo,
  keyevent,
  text,
  immersive,
  screenshot,
  screenOff,
};



