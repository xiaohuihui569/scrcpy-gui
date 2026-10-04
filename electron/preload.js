'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Wrap an on-channel so callers always get an unsubscribe function. */
function on(channel) {
  return (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

// Whitelist of everything the renderer is allowed to do. The renderer has no
// Node access, so this is the entire surface it can reach.
contextBridge.exposeInMainWorld('api', {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    relaunch: () => ipcRenderer.invoke('app:relaunch'),
  },

  tutorial: {
    setSuppressed: (v) => ipcRenderer.invoke('tutorial:seen', !!v),
    reset: () => ipcRenderer.invoke('tutorial:reset'),
  },

  devices: {
    list: () => ipcRenderer.invoke('devices:list'),
    refresh: () => ipcRenderer.invoke('devices:refresh'),
    // serial identifies WHICH phone to switch to network mode.
    tcpip: (serial, ip, port) => ipcRenderer.invoke('devices:tcpip', { serial, ip, port }),
    connect: (ip, port) => ipcRenderer.invoke('devices:connect', { ip, port }),
    invalidateIp: (serial) => ipcRenderer.invoke('devices:ip:invalidate', serial),
    names: {
      all: () => ipcRenderer.invoke('device:name:get'),
      set: (model, name) => ipcRenderer.invoke('device:name:set', model, name),
      onChange: on('device:names'),
    },
    onUpdate: on('devices:update'),
  },

  profile: {
    get: (serial) => ipcRenderer.invoke('profile:get', serial),
    getDefault: () => ipcRenderer.invoke('profile:default:get'),
    setDefault: (profile) => ipcRenderer.invoke('profile:default:set', profile),
    set: (serial, profile) => ipcRenderer.invoke('profile:set', serial, profile),
    diff: (serial, profile) => ipcRenderer.invoke('profile:diff', serial, profile),
    onDirty: on('profile:dirty'),
  },

  session: {
    start: (serial, profile) => ipcRenderer.invoke('session:start', serial, profile),
    stop: (serial) => ipcRenderer.invoke('session:stop', serial),
    restart: (serial, profile) => ipcRenderer.invoke('session:restart', serial, profile),
    state: (serial) => ipcRenderer.invoke('session:state', serial),
    states: () => ipcRenderer.invoke('session:states'),
    logs: (serial) => ipcRenderer.invoke('session:logs', serial),
    onState: on('session:state'),
    onExit: on('session:exit'),
    onStates: on('session:states'),
    onLog: on('session:log'),
  },

  device: {
    key: (serial, code) => ipcRenderer.invoke('key:send', serial, code),
    immersive: (serial, enable) => ipcRenderer.invoke('device:immersive', serial, enable),
    screenshot: (serial) => ipcRenderer.invoke('device:screenshot', serial),
  },

  shell: {
    openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
    openFolder: (p) => ipcRenderer.invoke('shell:openFolder', p),
  },

  dialog: {
    confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts),
    message: (opts) => ipcRenderer.invoke('dialog:message', opts),
  },
});
