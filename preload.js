const { contextBridge, ipcRenderer } = require('electron');
// 仅暴露业务方法，不把通用 IPC 或 Node 对象交给页面。
contextBridge.exposeInMainWorld('vesper', {
  themeReady: () => ipcRenderer.send('theme:ready'),
  load: () => ipcRenderer.invoke('state:load'),
  saveSettings: value => ipcRenderer.invoke('settings:save', value),
  revealKey: () => ipcRenderer.invoke('settings:reveal'),
  testConnection: value => ipcRenderer.invoke('connection:test', value),
  newChat: () => ipcRenderer.invoke('chat:new'),
  selectChat: id => ipcRenderer.invoke('chat:select', id),
  renameChat: (id, title) => ipcRenderer.invoke('chat:rename', { id, title }),
  deleteChat: id => ipcRenderer.invoke('chat:delete', id),
  clearChat: id => ipcRenderer.invoke('chat:clear', id),
  send: value => ipcRenderer.invoke('chat:send', value),
  stop: id => ipcRenderer.invoke('chat:stop', id),
  copy: value => ipcRenderer.invoke('clipboard:write', value),
  local: {
    state: () => ipcRenderer.invoke('local:state'),
    detectHardware: value => ipcRenderer.invoke('local:hardware', value),
    connect: () => ipcRenderer.invoke('local:ensure-service'),
    refresh: () => ipcRenderer.invoke('local:refresh'),
    chooseDirectory: () => ipcRenderer.invoke('local:choose-directory'),
    applyDirectory: () => ipcRenderer.invoke('local:apply-directory'),
    download: value => ipcRenderer.invoke('local:download', value),
    pause: id => ipcRenderer.invoke('local:pause', id),
    remove: id => ipcRenderer.invoke('local:delete', id),
    selectModel: id => ipcRenderer.invoke('local:select-model', id),
    installRuntime: () => ipcRenderer.invoke('local:install-runtime'),
    cancelInstall: () => ipcRenderer.invoke('local:cancel-install'),
    onDownloadProgress: callback => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('local:download-progress', listener);
      return () => ipcRenderer.removeListener('local:download-progress', listener);
    },
    onStateChanged: callback => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('local:state-changed', listener);
      return () => ipcRenderer.removeListener('local:state-changed', listener);
    }
  },
  onStream: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('chat:stream', listener);
    return () => ipcRenderer.removeListener('chat:stream', listener);
  }
});
