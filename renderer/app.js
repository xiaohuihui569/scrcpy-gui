'use strict';

/* ═══════════════════════════════════════════════════════════════
   Application state
   ═══════════════════════════════════════════════════════════════ */

const state = {
  appInfo: null,
  tutorialSuppressed: false,
  devices: [],
  selected: null,      // full device record
  sessionStates: {},   // serial -> { state, startedAt, exitCode, args }
  dirty: {},           // serial -> true when profile differs from running config
  profiles: {},        // serial -> profile currently shown in the UI
  logLines: [],        // { ts, level, text, serial }
  drawerCollapsed: false,
  autoIp: null,        // last IP written by the app (not typed by the user)
  names: {},          // lowercased model -> user-given device name
  renaming: false,    // true while an inline rename field is open
};

/** Quick keys that take effect immediately via adb keyevent. */
const KEYS = [
  { icon: '←', label: '返回', code: 4, tip: 'KEYCODE_BACK' },
  { icon: '⌂', label: '主页', code: 3, tip: 'KEYCODE_HOME' },
  { icon: '▤', label: '应用', code: 187, tip: 'KEYCODE_APP_SWITCH' },
  { icon: '🔊', label: '音量+', code: 24, tip: 'KEYCODE_VOLUME_UP' },
  { icon: '🔉', label: '音量−', code: 25, tip: 'KEYCODE_VOLUME_DOWN' },
  { icon: '⏻', label: '电源', code: 26, tip: 'KEYCODE_POWER' },
  { icon: '📸', label: '截图', action: 'screenshot', tip: '保存当前屏幕到图片文件夹' },
  { icon: '⛶', label: '沉浸', action: 'immersive', tip: '隐藏/显示系统栏' },
];

/** Parameter panel definition — single source of truth for the UI. */
const PARAM_GROUPS = [
  {
    name: '画质',
    fields: [
      { key: 'maxSize', label: '最大分辨率', type: 'number', placeholder: '0 = 设备原始', hint: '短边像素上限，如 1280' },
      { key: 'videoBitRate', label: '视频码率', type: 'text', placeholder: '0 = 默认 8M', hint: '支持 2M / 8M / 10000K' },
      { key: 'maxFps', label: '最大帧率', type: 'number', placeholder: '0 = 不限制', hint: '留空或 0 表示不限' },
      { key: 'videoCodec', label: '视频编码', type: 'select', options: ['', 'h264', 'h265', 'av1'] },
      { key: 'renderFit', label: '缩放方式', type: 'select', options: ['', 'letterbox', 'stretched', 'unscaled'] },
      { key: 'renderDriver', label: '渲染驱动', type: 'select', options: ['', 'direct3d', 'opengl', 'opengles2', 'vulkan'] },
      { key: 'angle', label: '画面旋转', type: 'number', placeholder: '0 / 90 / 180 / 270' },
      { key: 'noMipmaps', label: '禁用 mipmap', type: 'bool', hint: '文字更锐利，个别设备可能异常' },
    ],
  },
  {
    name: '窗口',
    fields: [
      { key: 'windowTitle', label: '窗口标题', type: 'text', placeholder: '留空使用默认' },
      { key: 'windowWidth', label: '初始宽度', type: 'number', placeholder: '自动' },
      { key: 'windowHeight', label: '初始高度', type: 'number', placeholder: '自动' },
      { key: 'windowX', label: '初始 X 坐标', type: 'text', placeholder: 'auto' },
      { key: 'windowY', label: '初始 Y 坐标', type: 'text', placeholder: 'auto' },
      { key: 'alwaysOnTop', label: '窗口置顶', type: 'bool' },
      { key: 'fullscreen', label: '全屏启动', type: 'bool' },
      { key: 'windowBorderless', label: '无边框窗口', type: 'bool' },
      { key: 'orientation', label: '初始方向', type: 'select', options: ['', '0', '90', '180', '270'] },
      { key: 'captureOrientation', label: '采集方向', type: 'select', options: ['', '0', '90', '180', '270', 'flip90', 'flip180', 'flip270'] },
    ],
  },
  {
    name: '音视频',
    fields: [
      { key: 'noAudio', label: '禁用音频转发', type: 'bool', hint: '关闭声音传输' },
      { key: 'noVideo', label: '禁用视频画面', type: 'bool', hint: '仅音频（配合 no-control）' },
      { key: 'audioCodec', label: '音频编码', type: 'select', options: ['', 'opus', 'aac', 'flac', 'raw'] },
      { key: 'noControl', label: '只读模式', type: 'bool', hint: '禁用鼠标键盘控制' },
      { key: 'keyboardMode', label: '键盘模式', type: 'select', options: ['', 'disabled', 'sdk', 'uhid', 'aoa'] },
      { key: 'mouseMode', label: '鼠标模式', type: 'select', options: ['', 'disabled', 'sdk', 'uhid', 'aoa'] },
      { key: 'gamepadMode', label: '手柄模式', type: 'select', options: ['', 'disabled', 'uhid', 'aoa'] },
      { key: 'noClipboardAutosync', label: '关闭剪贴板同步', type: 'bool' },
      { key: 'legacyPaste', label: '兼容粘贴模式', type: 'bool' },
      { key: 'preferText', label: '优先文本注入', type: 'bool' },
    ],
  },
  {
    name: '电源与连接',
    fields: [
      { key: 'stayAwake', label: '保持屏幕常亮', type: 'bool', hint: '镜像时模拟活跃状态' },
      { key: 'disableScreensaver', label: '禁用息屏', type: 'bool' },
      { key: 'powerOffOnClose', label: '关闭时熄屏', type: 'bool' },
      { key: 'turnScreenOff', label: '启动时熄屏', type: 'bool' },
      { key: 'killAdbOnClose', label: '关闭时结束 ADB', type: 'bool', hint: '多人共用时慎用' },
      { key: 'forceAdbForward', label: '强制 adb forward', type: 'bool', hint: '不用 adb reverse' },
      { key: 'showTouches', label: '显示触摸点', type: 'bool' },
    ],
  },
  {
    name: '录制',
    collapsed: true,
    fields: [
      { key: 'recordPath', label: '录制文件', type: 'text', placeholder: '留空 = 不录制', hint: '例如 D:\\cap\\demo.mp4' },
      { key: 'recordFormat', label: '录制格式', type: 'select', options: ['', 'mp4', 'mkv', 'm4a', 'opus', 'aac', 'flac'] },
      { key: 'timeLimit', label: '时长上限(秒)', type: 'number', placeholder: '0 = 不限' },
      { key: 'tcpip', label: '网络设备地址', type: 'text', placeholder: '留空 = USB', hint: '如 192.168.1.100:5555' },
      { key: 'extraArgs', label: '额外参数', type: 'text', placeholder: '--power-off-on-close', hint: '直接透传给 scrcpy' },
    ],
  },
];

const $ = (id) => document.getElementById(id);

/* ═══════════════════════════════════════════════════════════════
   Utilities
   ═══════════════════════════════════════════════════════════════ */

function toast(message, kind = 'info', ms = 2600) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toastWrap').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .2s';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

function showError(message) {
  if (!message) {
    $('errorBanner').classList.add('hidden');
    return;
  }
  $('errorBannerText').textContent = message;
  $('errorBanner').classList.remove('hidden');
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}

function isOnline(dev) {
  return dev && dev.state === 'device';
}

/* ═══════════════════════════════════════════════════════════════
   Device list
   ═══════════════════════════════════════════════════════════════ */

const STATE_TEXT = {
  device: '在线',
  unauthorized: '未授权',
  offline: '离线',
  recovery: '恢复中',
  sideload: '侧载中',
  bootloader: 'Bootloader',
  host: '主机',
};

/** Storage key for a custom name: the model identifies the phone. */
function modelKey(dev) {
  return String((dev && (dev.model || dev.product || dev.serial)) || '').toLowerCase();
}

/** The user-given name, or '' when this device has none. */
function customNameOf(dev) {
  return (dev && dev.customName) || state.names[modelKey(dev)] || '';
}

/**
 * A wireless serial is "ip:port"; a USB serial never contains a colon.
 * This is a pure shape test, so it stays correct while the device is
 * offline or unauthorized.
 */
function connectionKind(dev) {
  return /:\d+$/.test(String((dev && dev.serial) || '')) ? 'wireless' : 'wired';
}

function deviceLabel(dev) {
  const custom = customNameOf(dev);
  if (custom) return custom;
  if (dev.model) return dev.model;
  if (dev.product) return dev.product;
  return dev.serial;
}

/**
 * Turn the name row of a device card into an inline text field.
 * Enter saves, Esc cancels, clicking anywhere else discards the edit.
 */
function beginRename(item, dev) {
  const nameEl = item.querySelector('.dev-name');
  if (!nameEl || nameEl.querySelector('.dev-rename')) return;

  const input = document.createElement('input');
  input.className = 'dev-rename';
  input.type = 'text';
  input.maxLength = 24;
  input.value = customNameOf(dev) || deviceLabel(dev);
  input.title = '输入名称后回车保存，留空则清除名称';
  nameEl.textContent = '';
  nameEl.appendChild(input);
  state.renaming = true;
  input.focus();
  input.select();

  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    state.renaming = false;
    document.removeEventListener('mousedown', onAway, true);
    renderDevices();
    renderHeader();
  };

  const onAway = (e) => {
    if (e.target !== input) close();
  };

  input.addEventListener('keydown', async (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { close(); return; }
    if (e.key !== 'Enter') return;
    const value = input.value.trim();
    done = true;
    state.renaming = false;
    document.removeEventListener('mousedown', onAway, true);
    let res = null;
    try {
      res = await window.api.devices.names.set(modelKey(dev), value);
    } catch (err) {
      toast('保存名称失败：' + (err && err.message ? err.message : err), 'err');
    }
    if (res && res.ok) {
      state.names = res.names || state.names;
      toast(value ? `已重命名为「${value}」` : '已清除自定义名称', 'ok', 1600);
    } else if (res && res.error) {
      toast(res.error, 'err');
    }
    renderDevices();
    renderHeader();
  });

  document.addEventListener('mousedown', onAway, true);
}

function renderDevices() {
  // The device list is rebuilt on every 3s poll; doing that while the rename
  // field is open would wipe the input the user is typing into.
  if (state.renaming) return;

  const box = $('deviceList');
  box.innerHTML = '';

  if (!state.devices.length) {
    box.innerHTML = `<div class="dev-empty">没有检测到设备<br><span style="font-size:11px">请开启 USB 调试并连接数据线</span></div>`;
    return;
  }

  for (const dev of state.devices) {
    const item = document.createElement('div');
    const online = isOnline(dev);
    item.className = 'device-item';
    if (state.selected && state.selected.serial === dev.serial) item.classList.add('selected');
    if (!online) item.classList.add('dim');

    const sess = state.sessionStates[dev.serial];
    const running = sess && (sess.state === 'running' || sess.state === 'starting');

    const dotClass = online ? 'online' : (dev.state === 'unauthorized' ? 'unauthorized' : 'offline');
    const info = dev.info || {};
    const bits = [];
    if (info.androidRelease) bits.push(`Android ${info.androidRelease}`);
    if (info.batteryLevel !== null && info.batteryLevel !== undefined) bits.push(`${info.batteryLevel}%`);
    if (!info.androidRelease && dev.state !== 'device') bits.push(STATE_TEXT[dev.state] || dev.state);
    if (dev.transportId) bits.push(`id ${dev.transportId}`);

    const kind = connectionKind(dev);
    const kindText = kind === 'wireless' ? '无线' : '有线';

    item.innerHTML = `
      <span class="dev-dot ${dotClass}"></span>
      <div class="dev-info">
        <div class="dev-name"></div>
        <div class="dev-sub">
          <span class="dev-tag ${kind}">${kindText}</span>
          <span class="dev-meta-text"></span>
        </div>
      </div>
      ${running ? '<span class="dev-run">运行中</span>' : ''}
    `;
    item.querySelector('.dev-name').textContent = deviceLabel(dev);
    item.querySelector('.dev-meta-text').textContent = bits.join(' · ') || dev.serial;
    item.title = [
      deviceLabel(dev),
      dev.serial,
      `连接方式: ${kindText}`,
      `状态: ${STATE_TEXT[dev.state] || dev.state}`,
      '双击此处可修改名称',
    ].join('\n');

    item.addEventListener('click', () => selectDevice(dev.serial));
    item.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      beginRename(item, dev);
    });
    box.appendChild(item);
  }
}

/* ═══════════════════════════════════════════════════════════════
   TCP/IP target box
   ═══════════════════════════════════════════════════════════════ */

/** Split a wireless serial ("192.168.1.5:5555") into its two halves. */
function splitSerial(serial) {
  const m = /^(.*):(\d+)$/.exec(String(serial || ''));
  return m ? { ip: m[1], port: m[2] } : null;
}

/** True once the user has typed their own IP (we stop auto-overwriting then). */
function ipIsManual() {
  const v = $('tcpipInput').value.trim();
  return !!v && v !== (state.autoIp || '');
}

/**
 * Write the IP box unless the user has taken it over. `force` comes from the
 * "re-detect" button and overrides a manual value on purpose.
 */
function setIpField(ip, force = false) {
  const box = $('tcpipInput');
  if (!force && ipIsManual()) return false;
  box.value = ip || '';
  state.autoIp = ip || null;
  return true;
}

/** Reflect the current target device in the IP / port boxes. */
function syncIpFieldForDevice() {
  const dev = state.selected;
  const portBox = $('tcpipPortInput');

  // A wireless device already *is* an address: use it directly.
  const wireless = dev ? splitSerial(dev.serial) : null;
  if (wireless) {
    if (portBox.dataset.auto !== '0') {
      portBox.value = wireless.port;
      portBox.dataset.auto = '1';
    }
    setIpField(wireless.ip, false);
    return;
  }

  const info = (dev && dev.info) || {};
  setIpField(info.wifiIp || '', false);
}

/** Current "ip:port" target the user is pointing at. */
function currentTarget() {
  const ip = $('tcpipInput').value.trim();
  const port = $('tcpipPortInput').value.trim() || '5555';
  if (!ip) return null;
  return { ip, port };
}

/** Force a fresh Wi-Fi IP read for the selected device. */
async function refreshDetectedIp() {
  const serial = state.selected ? state.selected.serial : null;
  const btn = $('tcpipIpRefreshBtn');
  btn.classList.add('busy');
  try {
    await window.api.devices.invalidateIp(serial);
    const res = await window.api.devices.refresh();
    const devices = (res && res.devices) || state.devices;
    const fresh = devices.find((d) => d.serial === serial);
    return (fresh && fresh.info && fresh.info.wifiIp) || null;
  } finally {
    btn.classList.remove('busy');
  }
}

/* ═══════════════════════════════════════════════════════════════
   Selection + profile panel
   ═══════════════════════════════════════════════════════════════ */

async function selectDevice(serial) {
  const dev = state.devices.find((d) => d.serial === serial);
  if (!dev) return;

  if (state.selected && state.selected.serial !== serial) saveProfile(state.selected.serial);

  state.selected = dev;
  state.profiles[serial] = await window.api.profile.get(serial);
  renderDevices();
  renderHeader();
  renderParams();
  syncIpFieldForDevice();
  refreshSessionButtons();
  await loadLogs(serial);
}

function renderHeader() {
  const dev = state.selected;
  const has = !!dev;
  $('emptyState').classList.toggle('hidden', has);
  $('content').classList.toggle('hidden', !has);
  if (!has) return;

  const info = dev.info || {};
  const name = deviceLabel(dev);
  $('devName').textContent = name;

  const bits = [dev.serial];
  // Only worth showing the model when the name is not already the model.
  if (info.model && !customNameOf(dev)) bits.push(info.model);
  if (info.androidRelease) bits.push(`Android ${info.androidRelease}`);
  if (info.sdk) bits.push(`API ${info.sdk}`);
  if (dev.state !== 'device') bits.push(STATE_TEXT[dev.state] || dev.state);

  const kind = connectionKind(dev);
  const meta = $('devMeta');
  meta.textContent = '';
  const tag = document.createElement('span');
  tag.className = `dev-tag ${kind}`;
  tag.textContent = kind === 'wireless' ? '无线' : '有线';
  meta.appendChild(tag);
  const metaText = document.createElement('span');
  metaText.className = 'dev-meta-text';
  metaText.textContent = bits.join(' · ');
  meta.appendChild(metaText);
}

/* ── Parameter panel ───────────────────────────────────────── */

function currentProfile() {
  const serial = state.selected ? state.selected.serial : null;
  if (!serial) return {};
  if (!state.profiles[serial]) state.profiles[serial] = {};
  return state.profiles[serial];
}

function renderParams() {
  const host = $('paramGroups');
  host.innerHTML = '';
  const profile = currentProfile();

  for (const group of PARAM_GROUPS) {
    const g = document.createElement('div');
    g.className = 'group' + (group.collapsed ? ' collapsed' : '');

    const head = document.createElement('div');
    head.className = 'group-head';
    head.innerHTML = `<span class="group-caret">▼</span><span>${group.name}</span>`;
    head.addEventListener('click', () => g.classList.toggle('collapsed'));

    const body = document.createElement('div');
    body.className = 'group-body';

    for (const field of group.fields) {
      body.appendChild(buildField(field, profile));
    }

    g.appendChild(head);
    g.appendChild(body);
    host.appendChild(g);
  }
}

function buildField(field, profile) {
  const wrap = document.createElement('div');
  const value = profile[field.key];

  if (field.type === 'bool') {
    wrap.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = `f_${field.key}`;
    input.checked = Boolean(value);
    const label = document.createElement('span');
    label.textContent = field.label;
    wrap.appendChild(input);
    wrap.appendChild(label);
    if (field.hint) wrap.title = field.hint;
    input.addEventListener('change', () => {
      profile[field.key] = input.checked;
      onProfileChanged();
    });
    return wrap;
  }

  wrap.className = 'field';
  const label = document.createElement('label');
  label.textContent = field.label;
  label.htmlFor = `f_${field.key}`;
  wrap.appendChild(label);

  let input;
  if (field.type === 'select') {
    input = document.createElement('select');
    for (const opt of field.options) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt === '' ? '默认' : opt;
      input.appendChild(o);
    }
    input.value = value === undefined || value === null ? '' : String(value);
  } else {
    input = document.createElement('input');
    input.type = field.type === 'number' ? 'number' : 'text';
    input.min = '0';
    input.placeholder = field.placeholder || '';
    input.value = value === undefined || value === null || value === 0 && field.type === 'number'
      ? ''
      : String(value);
    if (field.type === 'number') {
      input.addEventListener('change', () => {
        const n = parseInt(input.value, 10);
        profile[field.key] = Number.isFinite(n) && n > 0 ? n : 0;
        onProfileChanged();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
      });
    }
  }

  input.id = `f_${field.key}`;
  input.addEventListener('change', () => {
    if (field.type !== 'number') {
      profile[field.key] = input.value;
      onProfileChanged();
    }
  });

  wrap.appendChild(input);
  if (field.hint) {
    const h = document.createElement('span');
    h.className = 'hint-inline';
    h.textContent = field.hint;
    wrap.appendChild(h);
  }
  return wrap;
}

async function onProfileChanged() {
  const serial = state.selected.serial;
  const profile = currentProfile();

  const saved = await window.api.profile.set(serial, profile);
  state.profiles[serial] = saved;

  if ($('applyToDefault').checked) {
    await window.api.profile.setDefault(saved);
  }

  const sess = state.sessionStates[serial];
  const running = sess && (sess.state === 'running' || sess.state === 'starting');
  const diff = await window.api.profile.diff(serial, saved);
  const dirty = running && diff.needsRestart;
  state.dirty[serial] = dirty;
  $('dirtyNotice').classList.toggle('hidden', !dirty);
}

async function saveProfile(serial) {
  if (!state.profiles[serial]) return;
  await window.api.profile.set(serial, state.profiles[serial]);
}

/* ═══════════════════════════════════════════════════════════════
   Session controls
   ═══════════════════════════════════════════════════════════════ */

function sessionState(serial) {
  const s = state.sessionStates[serial];
  return s ? s.state : 'stopped';
}

function refreshSessionButtons() {
  const dev = state.selected;
  if (!dev) return;
  const st = sessionState(dev.serial);
  const online = isOnline(dev);
  const active = st === 'running' || st === 'starting';

  $('startBtn').disabled = active || !online;
  $('stopBtn').disabled = !active;
  $('restartBtn').disabled = !active;

  const badge = $('sessionBadge');
  badge.className = 'state-badge ' + (st === 'stopped' ? '' : st);
  const label = { starting: '连接中', running: '运行中', error: '异常', stopped: '未启动' };
  let text = label[st] || st;
  if (st === 'error' && state.sessionStates[dev.serial]) {
    const code = state.sessionStates[dev.serial].exitCode;
    if (code !== null && code !== undefined && code !== 0) text = `异常(${code})`;
  }
  badge.querySelector('span').textContent = text;

  // Quick keys need an online device.
  for (const btn of document.querySelectorAll('.key-btn')) btn.disabled = !online;
  $('dirtyNotice').classList.toggle('hidden', !state.dirty[dev.serial]);
}

async function doStart() {
  const dev = state.selected;
  if (!dev) return;
  const serial = dev.serial;
  await saveProfile(serial);
  const res = await window.api.session.start(serial, currentProfile());
  if (!res.ok) {
    toast(res.error || '启动失败', 'err');
    return;
  }
  state.dirty[serial] = false;
  $('dirtyNotice').classList.add('hidden');
  refreshSessionButtons();
  toast('正在启动镜像…', 'info');
}

async function doStop() {
  const dev = state.selected;
  if (!dev) return;
  await window.api.session.stop(dev.serial);
  refreshSessionButtons();
}

async function doRestart() {
  const dev = state.selected;
  if (!dev) return;
  await window.api.session.restart(dev.serial, currentProfile());
  state.dirty[dev.serial] = false;
  $('dirtyNotice').classList.add('hidden');
  refreshSessionButtons();
  toast('已重启镜像', 'ok');
}

/* ═══════════════════════════════════════════════════════════════
   Quick keys
   ═══════════════════════════════════════════════════════════════ */

function renderKeys() {
  const grid = $('keyGrid');
  grid.innerHTML = '';
  for (const k of KEYS) {
    const btn = document.createElement('button');
    btn.className = 'key-btn';
    btn.title = k.tip;
    btn.innerHTML = `<span class="key-icon">${k.icon}</span><span class="key-label">${k.label}</span>`;
    btn.addEventListener('click', () => runQuickKey(k));
    grid.appendChild(btn);
  }
}

async function runQuickKey(k) {
  const dev = state.selected;
  if (!dev || !isOnline(dev)) {
    toast('请先选择一台在线设备', 'warn');
    return;
  }
  const serial = dev.serial;

  if (k.action === 'screenshot') {
    const res = await window.api.device.screenshot(serial);
    toast(res.ok ? '截图已保存' : `截图失败：${res.error}`, res.ok ? 'ok' : 'err');
    return;
  }

  if (k.action === 'immersive') {
    const btnState = state.immersiveOn || (state.immersiveOn = {});
    const next = !btnState[serial];
    const res = await window.api.device.immersive(serial, next);
    if (res.ok) {
      btnState[serial] = next;
      toast(next ? '已进入沉浸模式' : '已退出沉浸模式', 'ok', 1500);
    } else {
      toast(res.error || '操作失败', 'err');
    }
    return;
  }

  const res = await window.api.device.key(serial, k.code);
  if (!res.ok) toast(res.error || '发送失败', 'err');
}

/* ═══════════════════════════════════════════════════════════════
   Log drawer
   ═══════════════════════════════════════════════════════════════ */

function appendLog(entry) {
  state.logLines.push(entry);
  if (state.logLines.length > 400) state.logLines.shift();

  const view = $('logView');
  const line = document.createElement('div');
  line.className = `l-${entry.level}`;

  const ts = document.createElement('span');
  ts.className = 'l-ts';
  ts.textContent = fmtTime(entry.ts);

  const txt = document.createElement('span');
  txt.textContent = entry.text;

  line.appendChild(ts);
  line.appendChild(txt);
  view.appendChild(line);
  $('logEmpty').classList.add('hidden');

  if ($('autoScroll').checked) view.parentElement.scrollTop = view.parentElement.scrollHeight;
  $('logCount').textContent = String(state.logLines.length);
}

async function loadLogs(serial) {
  const logs = await window.api.session.logs(serial);
  state.logLines = logs;
  const view = $('logView');
  view.innerHTML = '';
  if (!logs.length) {
    $('logEmpty').classList.remove('hidden');
    $('logCount').textContent = '0';
    return;
  }
  for (const entry of logs) {
    const line = document.createElement('div');
    line.className = `l-${entry.level}`;
    const ts = document.createElement('span');
    ts.className = 'l-ts';
    ts.textContent = fmtTime(entry.ts);
    const txt = document.createElement('span');
    txt.textContent = entry.text;
    line.appendChild(ts);
    line.appendChild(txt);
    view.appendChild(line);
  }
  view.parentElement.scrollTop = view.parentElement.scrollHeight;
  $('logCount').textContent = String(logs.length);
}

function clearLogs() {
  state.logLines = [];
  $('logView').innerHTML = '';
  $('logEmpty').classList.remove('hidden');
  $('logCount').textContent = '0';
}

/* ═══════════════════════════════════════════════════════════════
   Events
   ═══════════════════════════════════════════════════════════════ */

/**
 * Show the built-in walkthrough. Auto-opened on first launch unless the user
 * opted out; always reopenable from the help button.
 */
function openTutorial() {
  const box = $('tutorialModal');
  if (!box) return;
  // Reflect the saved preference instead of forcing a fresh unticked box.
  $('tutorialDontShow').checked = !!state.tutorialSuppressed;
  box.classList.remove('hidden');
}

/**
 * Persist the checkbox state: ticked = never auto-open again, cleared =
 * auto-open on next launch. Saved whenever it changes, not only on close.
 */
function setTutorialSuppressed(v) {
  state.tutorialSuppressed = !!v;
  $('tutorialDontShow').checked = !!v;
  window.api.tutorial.setSuppressed(!!v);
}

function closeTutorial() {
  $('tutorialModal').classList.add('hidden');
}

window.openTutorial = openTutorial;

function bindEvents() {
  $('settingsBtn').addEventListener('click', () => openSettings());
  $('helpBtn').addEventListener('click', () => openTutorial());
  $('tutorialClose').addEventListener('click', closeTutorial);
  $('tutorialDontShow').addEventListener('change', (e) => {
    setTutorialSuppressed(e.target.checked);
  });
  $('tutorialOk').addEventListener('click', closeTutorial);
  $('tutorialModal').addEventListener('click', (e) => {
    if (e.target === $('tutorialModal')) closeTutorial();
  });
  $('refreshBtn').addEventListener('click', async () => {
    await window.api.devices.refresh();
    toast('已刷新', 'ok', 1200);
  });

  // Typing marks the IP box as user-owned, so polling stops overwriting it.
  $('tcpipInput').addEventListener('input', () => {
    state.autoIp = ipIsManual() ? null : $('tcpipInput').value.trim();
  });
  $('tcpipPortInput').addEventListener('input', () => {
    $('tcpipPortInput').dataset.auto = '0'; // user typed it: stop auto-targeting
  });

  $('tcpipIpRefreshBtn').addEventListener('click', async () => {
    const ip = await refreshDetectedIp();
    if (!ip) {
      toast('未获取到设备的 Wi-Fi IP，请确认手机已连接 Wi-Fi', 'warn');
      return;
    }
    setIpField(ip, true);
    toast(`已获取设备 IP：${ip}`, 'ok');
  });

  $('tcpipBtn').addEventListener('click', async () => {
    const target = currentTarget();
    if (!target) { toast('请输入 IP 地址', 'warn'); return; }
    const res = await window.api.devices.connect(target.ip, target.port);
    if (res.ok) {
      toast(`已连接 ${res.target}`, 'ok');
      await window.api.devices.refresh();
    } else {
      toast(res.error, 'err');
    }
  });

  $('tcpipModeBtn').addEventListener('click', async () => {
    const target = currentTarget();
    if (!target) { toast('请输入 IP 地址', 'warn'); return; }

    // Guard: nothing was detected and nothing was typed by hand.
    const dev = state.selected;
    const detected = dev && (splitSerial(dev.serial) || (dev.info && dev.info.wifiIp));
    if (!detected && !ipIsManual() && !state.autoIp) {
      toast('未获取到设备的 Wi-Fi IP，请确认手机已连接 Wi-Fi', 'warn');
      return;
    }

    const ok = await window.api.dialog.confirm({
      title: '开启网络调试',
      message: `将把设备切换到 TCP/IP 调试模式（${target.ip}:${target.port}）？`,
      detail: '请确保设备与电脑在同一网络下。此操作会重启设备上的 adbd 服务。',
    });
    if (!ok) return;
    const res = await window.api.devices.tcpip(dev.serial, target.ip, target.port);
    if (res.ok) {
      toast(`已在 ${res.target} 开启网络调试，USB 线可以拔掉了`, 'ok', 5000);
      await window.api.devices.refresh();
    } else {
      toast(res.error, 'err');
    }
  });

  $('startBtn').addEventListener('click', doStart);
  $('stopBtn').addEventListener('click', doStop);
  $('restartBtn').addEventListener('click', doRestart);
  $('dirtyRestartBtn').addEventListener('click', doRestart);

  $('resetBtn').addEventListener('click', async () => {
    if (!state.selected) return;
    const ok = await window.api.dialog.confirm({
      title: '恢复默认',
      message: '将当前设备的参数恢复为默认值？',
    });
    if (!ok) return;
    const def = await window.api.profile.getDefault();
    state.profiles[state.selected.serial] = def;
    await window.api.profile.set(state.selected.serial, def);
    renderParams();
    onProfileChanged();
    toast('已恢复默认', 'ok');
  });

  $('errorBannerClose').addEventListener('click', () => showError(null));

  $('drawerHead').addEventListener('click', (e) => {
    if (e.target.closest('.drawer-tools')) return;
    $('drawer').classList.toggle('collapsed');
    state.drawerCollapsed = $('drawer').classList.contains('collapsed');
  });

  $('copyLogBtn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const text = state.logLines.map((l) => `${fmtTime(l.ts)} ${l.text}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('日志已复制', 'ok', 1400);
    } catch {
      toast('复制失败', 'err');
    }
  });

  $('clearLogBtn').addEventListener('click', (e) => { e.stopPropagation(); clearLogs(); });

  $('openResDirBtn').addEventListener('click', () => {
    if (state.appInfo) window.api.shell.openFolder(state.appInfo.resourceDir);
  });

  // Settings modal
  const openSettings = () => {
    if (!state.appInfo) return;
    $('setVersion').textContent = `v${state.appInfo.version}`;
    $('setResDir').textContent = state.appInfo.resourceDir;
    $('setProfilePath').textContent = '(应用数据目录)';
    const integ = $('setIntegrity');
    integ.textContent = state.appInfo.integrity.ok ? '完整' : `缺少 ${state.appInfo.integrity.missing.join(', ')}`;
    integ.className = state.appInfo.integrity.ok ? 'good' : 'bad';
    $('setLogPath').textContent = '内存（不落盘）';
    $('settingsModal').classList.remove('hidden');
  };
  $('openAppDataBtn').addEventListener('click', () => {
    window.api.shell.openFolder(state.appInfo.resourceDir);
  });
  $('settingsClose').addEventListener('click', () => $('settingsModal').classList.add('hidden'));
  $('settingsOk').addEventListener('click', () => $('settingsModal').classList.add('hidden'));
  $('settingsModal').addEventListener('click', (e) => {
    if (e.target === $('settingsModal')) $('settingsModal').classList.add('hidden');
  });
  window.openSettings = openSettings;

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.ctrlKey && e.key === 'r') { e.preventDefault(); doRestart(); }
    else if (e.ctrlKey && e.key === ',') { e.preventDefault(); openSettings(); }
    else if (e.key === 'Delete') { e.preventDefault(); doStop(); }
    else if (e.key === 'F5') { e.preventDefault(); window.api.devices.refresh(); }
  });

  // Refresh actions when the window regains focus.
  window.addEventListener('focus', () => window.api.devices.refresh());
}

/* ═══════════════════════════════════════════════════════════════
   Main event subscriptions
   ═══════════════════════════════════════════════════════════════ */

function bindApiEvents() {
  window.api.devices.onUpdate((payload) => {
    const ok = payload.ok;
    showError(ok ? null : payload.error);

    const pill = $('adbStatus');
    if (ok) {
      pill.className = 'status-pill ok';
      pill.querySelector('span').textContent = `${payload.devices.length} 台设备`;
    } else {
      pill.className = 'status-pill err';
      pill.querySelector('span').textContent = 'ADB 异常';
    }

    state.devices = payload.devices;
    renderDevices();

    // Keep the selection pointing at a live record.
    if (state.selected) {
      const found = state.devices.find((d) => d.serial === state.selected.serial);
      if (found) {
        const metaChanged = JSON.stringify(found.info) !== JSON.stringify(state.selected.info);
        state.selected = found;
        if (metaChanged) {
          renderHeader();
          syncIpFieldForDevice();
        }
        if (!isOnline(found)) refreshSessionButtons();
      } else {
        state.selected = null;
        $('emptyState').classList.remove('hidden');
        $('content').classList.add('hidden');
        renderDevices();
      }
    }
  });

  // Custom names live in their own store, keyed by model.
  window.api.devices.names.onChange((table) => {
    state.names = table || {};
    renderDevices();
    renderHeader();
  });

  window.api.session.onState(({ serial, state: snap, states }) => {
    state.sessionStates = states || state.sessionStates;
    if (state.selected && state.selected.serial === serial) refreshSessionButtons();
    renderDevices();
  });

  window.api.session.onExit(({ serial, state: snap }) => {
    if (state.selected && state.selected.serial === serial) {
      refreshSessionButtons();
      if (snap.state === 'error') toast(`镜像异常退出（${snap.exitCode}）`, 'err');
    }
    renderDevices();
  });

  window.api.session.onStates((states) => { state.sessionStates = states; });

  window.api.session.onLog(({ serial, entry }) => {
    // Only show logs for the device currently being inspected.
    if (state.selected && state.selected.serial === serial) appendLog(entry);
  });

  window.api.profile.onDirty(({ serial, needsRestart }) => {
    if (state.selected && state.selected.serial === serial) {
      state.dirty[serial] = needsRestart;
      $('dirtyNotice').classList.toggle('hidden', !needsRestart);
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
   Bootstrap
   ═══════════════════════════════════════════════════════════════ */

async function init() {
  state.appInfo = await window.api.app.info();
  $('appVersion').textContent = `v${state.appInfo.version}`;
  state.names = state.appInfo.names || {};
  state.tutorialSuppressed = !!state.appInfo.tutorialSuppressed;

  bindEvents();
  bindApiEvents();
  renderKeys();

  const states = await window.api.session.states();
  state.sessionStates = states || {};

  // First launch: show the walkthrough unless the user opted out.
  if (state.appInfo.showTutorial) setTimeout(() => openTutorial(), 260);

  const list = await window.api.devices.list();
  if (list.ok) {
    state.devices = list.devices;
    renderDevices();
    $('adbStatus').className = 'status-pill ok';
    $('adbStatus').querySelector('span').textContent = `${list.devices.length} 台设备`;
  }

  if (!state.appInfo.integrity.ok) {
    showError(`缺少组件: ${state.appInfo.integrity.missing.join(', ')}`);
  }
}

init();

