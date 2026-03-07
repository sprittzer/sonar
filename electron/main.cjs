const { app, BrowserWindow } = require('electron')
const path = require('path')
const { startMeshBridge } = require('./meshBridge.cjs')

let bridgeController = null

async function startInternalBridge() {
  if (bridgeController) return
  bridgeController = startMeshBridge({
    wsPort: Number(process.env.BRIDGE_PORT || 8788),
    udpPort: Number(process.env.MESH_UDP_PORT || 41234)
  })
}

function stopInternalBridge() {
  if (!bridgeController) return
  try {
    bridgeController.stop()
  } catch (error) {
    console.error(`Failed to stop mesh bridge: ${error.message}`)
  }
  bridgeController = null
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    win.loadURL(devServerUrl)
    win.webContents.openDevTools({ mode: 'detach' })
    return
  }

  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
}

app.whenReady().then(() => {
  // Desktop mode uses built-in bridge in both dev and packaged runs.
  if (process.env.DISABLE_INTERNAL_BRIDGE !== '1') {
    startInternalBridge()
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  stopInternalBridge()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
