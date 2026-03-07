import { WebSocketServer } from 'ws'

const WS_PORT = Number(process.env.BLE_BRIDGE_PORT || 8790)
const SERVICE_UUID = '1234567812345678123456789abc0001'
const RX_UUID = '1234567812345678123456789abc0002' // write
const TX_UUID = '1234567812345678123456789abc0003' // notify
const MTU_PAYLOAD = 180

const peers = new Map()
const seen = new Set()
const clients = new Set()
const devicesByAddr = new Map()

let noble = null
let bleno = null
let running = false
let nodeId = `n-${Math.random().toString(16).slice(2, 10)}`
let displayName = 'User'
let capabilities = ['chat', 'signal', 'av']

function emit(event, payload = {}) {
  const data = JSON.stringify({ event, payload })
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data)
  }
}

function warn(message) {
  emit('error', { message })
  console.warn(`[ble-bridge] ${message}`)
}

function peersArray() {
  return [...peers.values()].map((p) => ({
    nodeId: p.nodeId,
    displayName: p.displayName || p.nodeId,
    address: p.address || '',
    port: -1,
    capabilities: p.capabilities || ['ble'],
    lastSeenMs: p.lastSeenMs || Date.now()
  }))
}

function emitPeers() {
  emit('peersUpdate', { peers: peersArray() })
}

function normalizeEnvelope(envelope) {
  return {
    msgId: envelope.msgId || `m-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    from: envelope.from || nodeId,
    to: envelope.to || '*',
    ttl: Number.isFinite(envelope.ttl) ? envelope.ttl : 8,
    type: envelope.type || 'UNKNOWN',
    payload: envelope.payload || {},
    sig: envelope.sig || ''
  }
}

function sendFrames(device, jsonText) {
  if (!device?.txWrite) return
  const total = Math.ceil(jsonText.length / MTU_PAYLOAD)
  const frameId = `f-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`

  for (let i = 0; i < total; i++) {
    const chunk = jsonText.slice(i * MTU_PAYLOAD, (i + 1) * MTU_PAYLOAD)
    const frame = JSON.stringify({ frameId, idx: i, total, chunk })
    try {
      device.txWrite(Buffer.from(frame, 'utf8'))
    } catch (e) {
      warn(`BLE write failed: ${e.message}`)
      break
    }
  }
}

function sendBleMessage(device, message) {
  sendFrames(device, JSON.stringify(message))
}

function getDeviceByNodeId(targetNodeId) {
  for (const d of devicesByAddr.values()) {
    if (d.nodeId === targetNodeId) return d
  }
  return null
}

function forwardEnvelope(envelope, excludeDevice = null) {
  const wrapped = { kind: 'MESH', envelope }
  const to = envelope.to || '*'

  if (to !== '*') {
    const target = getDeviceByNodeId(to)
    if (target) sendBleMessage(target, wrapped)
    return
  }

  for (const d of devicesByAddr.values()) {
    if (excludeDevice && d === excludeDevice) continue
    sendBleMessage(d, wrapped)
  }
}

function onBleJson(device, message) {
  if (!message || typeof message !== 'object') return

  if (message.kind === 'HELLO' || message.kind === 'HELLO_ACK') {
    const remoteNodeId = message.nodeId
    if (!remoteNodeId || remoteNodeId === nodeId) return

    device.nodeId = remoteNodeId
    peers.set(remoteNodeId, {
      nodeId: remoteNodeId,
      displayName: message.displayName || remoteNodeId,
      address: `ble:${device.address || device.id || 'unknown'}`,
      capabilities: Array.isArray(message.capabilities) ? message.capabilities : ['ble'],
      lastSeenMs: Date.now()
    })
    emitPeers()

    if (message.kind === 'HELLO') {
      sendBleMessage(device, {
        kind: 'HELLO_ACK',
        nodeId,
        displayName,
        capabilities
      })
    }
    return
  }

  if (message.kind === 'MESH' && message.envelope) {
    const envelope = message.envelope
    if (!envelope.msgId || seen.has(envelope.msgId)) return

    seen.add(envelope.msgId)
    if (seen.size > 10000) seen.clear()

    const to = envelope.to || '*'
    if (to === '*' || to === nodeId) {
      emit('meshPacket', { envelope })
    }

    const ttl = Number(envelope.ttl || 0)
    if (ttl > 0 && to !== nodeId) {
      forwardEnvelope({ ...envelope, ttl: ttl - 1 }, device)
    }
  }
}

function onBleFrame(device, text) {
  let frame
  try {
    frame = JSON.parse(text)
  } catch {
    return
  }

  if (!frame?.frameId || !Number.isInteger(frame?.idx) || !Number.isInteger(frame?.total)) return

  if (!device.frames) device.frames = new Map()
  const state = device.frames.get(frame.frameId) || { total: frame.total, chunks: [] }
  state.chunks[frame.idx] = frame.chunk || ''
  device.frames.set(frame.frameId, state)

  const complete = state.chunks.filter((c) => typeof c === 'string').length === state.total
  if (!complete) return

  device.frames.delete(frame.frameId)
  const textPayload = state.chunks.join('')
  try {
    onBleJson(device, JSON.parse(textPayload))
  } catch {
    // ignore malformed
  }
}

async function startBlenoPeripheral() {
  let mod
  try {
    mod = await import('@abandonware/bleno')
  } catch {
    warn('BLE peripheral disabled: install @abandonware/bleno')
    return
  }

  bleno = mod.default || mod
  if (!bleno) return

  const Characteristic = bleno.Characteristic
  const PrimaryService = bleno.PrimaryService
  const subscribers = new Set()

  const txCharacteristic = new Characteristic({
    uuid: TX_UUID,
    properties: ['notify'],
    onSubscribe(_maxValueSize, updateValueCallback) {
      subscribers.add(updateValueCallback)
    },
    onUnsubscribe() {
      subscribers.clear()
    }
  })

  const rxCharacteristic = new Characteristic({
    uuid: RX_UUID,
    properties: ['writeWithoutResponse', 'write'],
    onWriteRequest(data, _offset, _withoutResponse, callback) {
      const pseudoDevice = {
        id: 'peripheral-link',
        address: 'peripheral-link',
        txWrite: (buf) => {
          for (const cb of subscribers) cb(buf)
        },
        frames: new Map(),
        nodeId: ''
      }
      onBleFrame(pseudoDevice, data.toString('utf8'))
      callback(0)
    }
  })

  const service = new PrimaryService({
    uuid: SERVICE_UUID,
    characteristics: [rxCharacteristic, txCharacteristic]
  })

  bleno.on('stateChange', (state) => {
    if (state !== 'poweredOn') return
    bleno.startAdvertising(`hex-${nodeId.slice(0, 6)}`, [SERVICE_UUID], (err) => {
      if (err) warn(`BLE advertising failed: ${err.message}`)
    })
  })

  bleno.on('advertisingStart', (err) => {
    if (err) {
      warn(`BLE advertising start error: ${err.message}`)
      return
    }
    bleno.setServices([service], (e) => {
      if (e) warn(`BLE setServices failed: ${e.message}`)
    })
  })
}

async function startNobleCentral() {
  let mod
  try {
    mod = await import('@abandonware/noble')
  } catch {
    warn('BLE central disabled: install @abandonware/noble')
    return
  }

  noble = mod.default || mod
  if (!noble) return

  noble.on('stateChange', async (state) => {
    if (state !== 'poweredOn') return
    try {
      if (typeof noble.startScanningAsync === 'function') {
        await noble.startScanningAsync([SERVICE_UUID], true)
      } else {
        noble.startScanning([SERVICE_UUID], true)
      }
    } catch (e) {
      warn(`BLE scan start failed: ${e.message}`)
    }
  })

  noble.on('discover', async (peripheral) => {
    const address = peripheral.address || peripheral.id
    if (!address || devicesByAddr.has(address)) return

    const device = {
      id: peripheral.id,
      address,
      peripheral,
      nodeId: '',
      txWrite: null,
      frames: new Map()
    }
    devicesByAddr.set(address, device)

    try {
      if (typeof peripheral.connectAsync === 'function') {
        await peripheral.connectAsync()
      } else {
        await new Promise((resolve, reject) => peripheral.connect((err) => (err ? reject(err) : resolve())))
      }

      const result = typeof peripheral.discoverSomeServicesAndCharacteristicsAsync === 'function'
        ? await peripheral.discoverSomeServicesAndCharacteristicsAsync([SERVICE_UUID], [RX_UUID, TX_UUID])
        : await new Promise((resolve, reject) => {
            peripheral.discoverSomeServicesAndCharacteristics([SERVICE_UUID], [RX_UUID, TX_UUID], (err, services, characteristics) => {
              if (err) reject(err)
              else resolve({ services, characteristics })
            })
          })

      const chars = result.characteristics || []
      const rx = chars.find((c) => c.uuid === RX_UUID)
      const tx = chars.find((c) => c.uuid === TX_UUID)
      if (!rx || !tx) throw new Error('BLE characteristics not found')

      device.txWrite = (buf) => {
        if (typeof rx.writeAsync === 'function') return rx.writeAsync(buf, false)
        return rx.write(buf, false, () => {})
      }

      if (typeof tx.subscribeAsync === 'function') await tx.subscribeAsync()
      else tx.subscribe()

      tx.on('data', (data) => {
        onBleFrame(device, data.toString('utf8'))
      })

      sendBleMessage(device, {
        kind: 'HELLO',
        nodeId,
        displayName,
        capabilities
      })

      peripheral.on('disconnect', () => {
        devicesByAddr.delete(address)
        if (device.nodeId) peers.delete(device.nodeId)
        emitPeers()
      })
    } catch (e) {
      warn(`BLE connect failed (${address}): ${e.message}`)
      devicesByAddr.delete(address)
    }
  })
}

async function startMesh(params = {}) {
  if (running) return
  if (params.nodeId) nodeId = params.nodeId
  if (params.displayName) displayName = params.displayName
  if (Array.isArray(params.capabilities) && params.capabilities.length) capabilities = params.capabilities

  await startBlenoPeripheral()
  await startNobleCentral()

  running = true
  emit('state', { state: 'running', nodeId, transport: 'ble' })
}

async function stopMesh() {
  running = false

  try {
    if (noble) {
      if (typeof noble.stopScanningAsync === 'function') await noble.stopScanningAsync()
      else noble.stopScanning()
      noble.removeAllListeners()
    }
  } catch {}
  noble = null

  try {
    if (bleno) {
      bleno.stopAdvertising()
      bleno.removeAllListeners()
    }
  } catch {}
  bleno = null

  devicesByAddr.clear()
  peers.clear()
  seen.clear()
  emitPeers()
  emit('state', { state: 'stopped' })
}

const wss = new WebSocketServer({ port: WS_PORT })

wss.on('connection', (ws) => {
  clients.add(ws)
  ws.send(JSON.stringify({ event: 'state', payload: { state: running ? 'running' : 'stopped', nodeId, transport: 'ble' } }))
  ws.send(JSON.stringify({ event: 'peersUpdate', payload: { peers: peersArray() } }))

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString('utf8'))
    } catch {
      return
    }

    if (msg.action === 'start') {
      Promise.resolve(startMesh(msg.payload || {})).catch((error) => {
        emit('error', { message: `Start failed: ${error.message}` })
      })
      return
    }

    if (msg.action === 'stop') {
      Promise.resolve(stopMesh()).catch((error) => {
        emit('error', { message: `Stop failed: ${error.message}` })
      })
      return
    }

    if (msg.action === 'sendPacket' && msg.payload?.envelope) {
      const envelope = normalizeEnvelope(msg.payload.envelope)
      if (!seen.has(envelope.msgId)) {
        seen.add(envelope.msgId)
        if (seen.size > 10000) seen.clear()
      }
      const to = envelope.to || '*'
      if (to === '*' || to === nodeId) {
        emit('meshPacket', { envelope })
      }
      const ttl = Number(envelope.ttl || 0)
      if (ttl > 0) {
        forwardEnvelope({ ...envelope, ttl: ttl - 1 }, null)
      }
      return
    }

    if (msg.action === 'getPeers') {
      ws.send(JSON.stringify({ event: 'peersUpdate', payload: { peers: peersArray() } }))
    }
  })

  ws.on('close', () => {
    clients.delete(ws)
  })
})

process.on('SIGINT', () => {
  Promise.resolve(stopMesh()).finally(() => process.exit(0))
})
process.on('SIGTERM', () => {
  Promise.resolve(stopMesh()).finally(() => process.exit(0))
})

console.log(`BLE bridge listening on ws://0.0.0.0:${WS_PORT}`)
console.log('Install deps: @abandonware/noble @abandonware/bleno')
