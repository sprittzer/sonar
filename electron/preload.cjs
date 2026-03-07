const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('desktopMeta', {
  platform: process.platform,
  versions: process.versions
})
