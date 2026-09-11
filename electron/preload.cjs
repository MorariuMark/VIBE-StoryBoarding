/**
 * Preload: minimal safe bridge. The renderer talks to the Audio8 sidecar over
 * plain HTTP already, so this only exposes sidecar status + app info.
 */
const { contextBridge, ipcRenderer } = require('electron');

let sidecar = { mode: 'unknown', port: 8010 };
ipcRenderer.on('audio8-sidecar', (_e, info) => {
  sidecar = info;
});

contextBridge.exposeInMainWorld('handscribe', {
  platform: process.platform,
  isDesktop: true,
  audio8Sidecar: () => ({ ...sidecar }),
});
