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
  onStream: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('chat:stream', listener);
    return () => ipcRenderer.removeListener('chat:stream', listener);
  }
});
