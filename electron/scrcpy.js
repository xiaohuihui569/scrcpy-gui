'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const adb = require('./adb');
const { buildArgs, diffRequiresRestart } = require('./profile');

const LOG_LIMIT = 200;
const KILL_GRACE_MS = 2000;

/**
 * One mirror session per device serial. Sessions are fully independent, so
 * several devices can be mirrored at the same time.
 *
 * state: stopped | starting | running | error
 */
class Session extends EventEmitter {
  constructor(serial) {
    super();
    this.serial = serial;
    this.proc = null;
    this.state = 'stopped';
    this.startedAt = null;
    this.exitCode = null;
    this.lastArgs = [];
    this.appliedProfile = null;
    this.log = [];
    this.carry = '';
  }

  snapshot() {
    return {
      serial: this.serial,
      state: this.state,
      startedAt: this.startedAt,
      exitCode: this.exitCode,
      args: this.lastArgs,
    };
  }

  pushLog(text, level = 'info') {
    const entry = { ts: Date.now(), level, text };
    this.log.push(entry);
    if (this.log.length > LOG_LIMIT) this.log.shift();
    this.emit('log', entry, this.serial);
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', this.snapshot(), this.serial);
  }

  /** Launch the native scrcpy window for this device. */
  start(profile) {
    if (this.proc) return { ok: false, error: '会话已在运行' };
    const args = buildArgs(this.serial, profile);
    this.lastArgs = args;
    this.appliedProfile = JSON.parse(JSON.stringify(profile || {}));
    this.exitCode = null;
    this.setState('starting');
    this.pushLog(`启动: scrcpy.exe ${args.join(' ')}`, 'cmd');

    let child;
    try {
      child = spawn(adb.binPath('scrcpy.exe'), args, {
        cwd: adb.resourceDir(),
        windowsHide: true,
      });
    } catch (err) {
      this.setState('error');
      this.pushLog(`无法启动 scrcpy: ${err.message}`, 'error');
      return { ok: false, error: String(err.message) };
    }

    this.proc = child;
    this.startedAt = Date.now();

    const out = (d) => this.handleLine(d.toString());
    child.stdout.on('data', out);
    child.stderr.on('data', out);
    child.on('error', (err) => {
      this.pushLog(`进程错误: ${err.message}`, 'error');
      this.setState('error');
    });
    child.on('close', (code) => {
      this.flushCarry();
      this.proc = null;
      this.exitCode = code === null ? -1 : code;
      if (code === 0) {
        this.setState('stopped');
        this.pushLog('镜像窗口已关闭。', 'info');
      } else {
        this.setState('error');
        this.pushLog(`scrcpy 异常退出，代码 ${this.exitCode}`, 'error');
      }
      this.emit('exit', this.snapshot(), this.serial);
    });

    return { ok: true, args };
  }

  /**
   * Parse scrcpy's log output to advance state and surface errors.
   * stdout/stderr arrive in arbitrary chunks, so a partial trailing line is
   * carried over to the next chunk instead of being logged as a broken line.
   */
  handleLine(chunk) {
    this.carry += chunk;
    const lines = this.carry.split(/\r?\n/);
    this.carry = lines.pop() || '';

    for (const raw of lines) {
      const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
      if (!line.trim()) continue;
      this.emitLine(line);
    }
  }

  /** Flush any trailing partial line (called when the process exits). */
  flushCarry() {
    if (!this.carry.trim()) { this.carry = ''; return; }
    const line = this.carry.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
    this.carry = '';
    if (line) this.emitLine(line);
  }

  emitLine(line) {
    let level = 'info';
    if (/\bERROR\b/i.test(line) || /\bFATAL\b/i.test(line)) level = 'error';
    else if (/\bWARN(ING)?\b/i.test(line)) level = 'warn';
    else if (/\bDEBUG\b/i.test(line)) level = 'debug';
    this.pushLog(line, level);

    // "Device: <serial>  [model] ..." marks a live session.
    const m = /Device:\s*(\S+)/.exec(line);
    if (m && (this.state === 'starting' || this.state === 'stopped')) {
      this.setState('running');
      this.pushLog(`设备已连接: ${m[1]}`, 'info');
    }
    if (/Server connection complete|renderer_\d+ .*fps/i.test(line) && this.state === 'starting') {
      this.setState('running');
    }
  }

  /** Graceful stop: SIGTERM first, then taskkill if it lingers. */
  async stop() {
    if (!this.proc) {
      this.setState('stopped');
      return { ok: true };
    }
    const proc = this.proc;
    this.pushLog('请求停止…', 'info');
    try { proc.kill(); } catch { /* already gone */ }

    const exited = await this.waitExit(proc, KILL_GRACE_MS);
    if (!exited) {
      this.pushLog('进程未响应，强制结束。', 'warn');
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
          windowsHide: true,
        });
        killer.on('close', () => resolve());
        killer.on('error', () => resolve());
      });
      await this.waitExit(proc, 1000);
    }
    this.setState('stopped');
    return { ok: true };
  }

  waitExit(proc, ms) {
    if (!proc || proc.exitCode !== null || proc.killed === undefined) {
      // fallthrough; waitExit below still guards with the closed flag
    }
    return new Promise((resolve) => {
      if (!proc || !this.proc || this.proc !== proc) return resolve(true);
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => finish(false), ms);
      proc.once('close', () => finish(true));
    });
  }

  async restart(profile) {
    this.pendingRestart = false;
    await this.stop();
    return this.start(profile);
  }

  getLogs() {
    return this.log.slice();
  }
}

/** Registry of all sessions, keyed by serial. */
class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
  }

  get(serial) {
    if (!this.sessions.has(serial)) {
      const s = new Session(serial);
      s.on('log', (entry, ser) => this.emit('log', entry, ser));
      s.on('state', (snap, ser) => this.emit('state', snap, ser));
      s.on('exit', (snap, ser) => this.emit('exit', snap, ser));
      this.sessions.set(serial, s);
    }
    return this.sessions.get(serial);
  }

  async start(serial, profile) {
    return this.get(serial).start(profile);
  }

  async stop(serial) {
    return this.get(serial).stop();
  }

  async restart(serial, profile) {
    return this.get(serial).restart(profile);
  }

  /** Update the profile of a live session without touching the process. */
  updateProfile(serial, profile) {
    const s = this.get(serial);
    s.appliedProfile = JSON.parse(JSON.stringify(profile || {}));
  }

  /** True when the running process was launched with different settings. */
  needsRestart(serial, profile) {
    const s = this.get(serial);
    if (!s.appliedProfile) return false;
    return diffRequiresRestart(s.appliedProfile, profile).length > 0;
  }

  stateOf(serial) {
    return this.sessions.has(serial) ? this.sessions.get(serial).snapshot() : null;
  }

  allStates() {
    const out = {};
    for (const [serial, s] of this.sessions) out[serial] = s.snapshot();
    return out;
  }

  logsOf(serial) {
    return this.sessions.has(serial) ? this.sessions.get(serial).getLogs() : [];
  }

  async stopAll() {
    await Promise.all([...this.sessions.keys()].map((k) => this.stop(k)));
  }
}

module.exports = { Session, SessionManager, LOG_LIMIT };

