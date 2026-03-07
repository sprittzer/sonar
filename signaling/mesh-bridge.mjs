import dgram from 'node:dgram'
import { WebSocketServer } from 'ws'

const WS_PORT = Number(process.env.BRIDGE_PORT || 8788)
const UDP_PORT = Number(process.env.MESH_UDP_PORT || 41234)
const HELLO_INTERVAL_MS = 1500
const PEER_TTL_MS = 10000

const TRANSPORT_LAN = 'lan'
const TRANSPORT_BLE = 'ble'
const TRANSPORT_HYBRID = 'hybrid'
const BLE_SERVICE_UUID_NODASH = '1234567812345678123456789abc0001'

const peers = new Map()
const seen = new Set()
const clients = new Set()

let nodeId = `n-${Math.random().toString(16).slice(2, 10)}`
let displayName = 'User'
let capabilities = ['chat', 'signal', 'av']
let transportMode = TRANSPORT_HYBRID

let running = false
let socket = null
let helloTimer = null
let pruneTimer = null
let bonjour = null
let browser = null
let service = null

let noble = null
let bleActive = false
let nobleStateHandler = null
let nobleDiscoverHandler = null

function emit(event, payload = {}) {
  const data = JSON.stringify({ event, payload })
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data)
  }
}

function warn(message) {
  emit('error', { message })
  console.warn(message)
}

function isLanEnabled() {
  return transportMode === TRANSPORT_LAN || transportMode === TRANSPORT_HYBRID
}

function isBleEnabled() {
  return transportMode === TRANSPORT_BLE || transportMode === TRANSPORT_HYBRID
}

function peersArray() {
  return [...peers.values()].map((p) => ({
    nodeId: p.nodeId,
    displayName: p.displayName || p.nodeId,
    address: p.address,
    port: p.port,
    capabilities: p.capabilities,
    lastSeenMs: p.lastSeenMs
  }))
}

function emitPeers() {
  emit('peersUpdate', { peers: peersArray() })
}

function upsertPeer(peer) {
  if (!peer.nodeId || peer.nodeId === nodeId) return
  peers.set(peer.nodeId, {
    ...peer,
    lastSeenMs: Date.now()
  })
  emitPeers()
}

function sendUdp(obj, address, port) {
  if (!socket || !isLanEnabled()) return
  const data = Buffer.from(JSON.stringify(obj), 'utf8')
  socket.send(data, port, address)
}

function buildHello(kind) {
  return {
    kind,
    nodeId,
    displayName,
    port: UDP_PORT,
    capabilities
  }
}

function sendHelloTo(address, port) {
  sendUdp(buildHello('HELLO'), address, port)
}

function sendHelloAckTo(address, port) {
  sendUdp(buildHello('HELLO_ACK'), address, port)
}

function broadcastHello() {
  if (!isLanEnabled()) return
  sendUdp(buildHello('HELLO'), '255.255.255.255', UDP_PORT)
  for (const peer of peers.values()) {
    sendUdp(buildHello('HELLO'), peer.address, peer.port)
  }
}

function prunePeers() {
  const now = Date.now()
  let changed = false
  for (const [id, peer] of peers.entries()) {
    if (now - peer.lastSeenMs > PEER_TTL_MS) {
      peers.delete(id)
      changed = true
    }
  }
  if (changed) emitPeers()
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

function forwardEnvelope(envelope, excludeKey = '') {
  if (!isLanEnabled()) return
  const wrapper = { kind: 'MESH', envelope }

  if (envelope.to !== '*' && peers.has(envelope.to)) {
    const target = peers.get(envelope.to)
    if (target && target.port > 0 && !String(target.address || '').startsWith('ble:')) {
      sendUdp(wrapper, target.address, target.port)
    }
    return
  }

  for (const peer of peers.values()) {
    if (peer.port <= 0 || String(peer.address || '').startsWith('ble:')) continue
    const key = `${peer.address}:${peer.port}`
    if (excludeKey && key === excludeKey) continue
    sendUdp(wrapper, peer.address, peer.port)
  }
}

function onMeshEnvelope(envelope, sourceKey = '') {
  const msgId = envelope?.msgId
  if (!msgId || seen.has(msgId)) return

  seen.add(msgId)
  if (seen.size > 10000) seen.clear()

  const to = envelope.to || '*'
  const forMe = to === '*' || to === nodeId
  if (forMe) {
    emit('meshPacket', { envelope })
  }

  const ttl = Number(envelope.ttl || 0)
  if (ttl <= 0) return

  if (to !== nodeId) {
    forwardEnvelope({ ...envelope, ttl: ttl - 1 }, sourceKey)
  }
}

function onUdpMessage(raw, rinfo) {
  let data
  try {
    data = JSON.parse(raw.toString('utf8'))
  } catch {
    return
  }

  if (data.kind === 'HELLO' || data.kind === 'HELLO_ACK') {
    upsertPeer({
      nodeId: data.nodeId,
      displayName: data.displayName || data.nodeId,
      address: rinfo.address,
      port: data.port || rinfo.port,
      capabilities: Array.isArray(data.capabilities) ? data.capabilities : []
    })

    if (data.kind === 'HELLO') {
      sendHelloAckTo(rinfo.address, data.port || rinfo.port)
    }
    return
  }

  if (data.kind === 'MESH' && data.envelope) {
    const sourceKey = `${rinfo.address}:${rinfo.port}`
    onMeshEnvelope(data.envelope, sourceKey)
  }
}

async function startMdns() {
  if (!isLanEnabled()) return

  let BonjourCtor
  try {
    const mod = await import('bonjour-service')
    BonjourCtor = mod.Bonjour
  } catch {
    warn('mDNS disabled in helper: package bonjour-service is not installed. UDP fallback is active.')
    return
  }

  bonjour = new BonjourCtor()

  service = bonjour.publish({
    name: `hex-${nodeId.slice(0, 6)}`,
    type: 'hexmesh',
    protocol: 'udp',
    port: UDP_PORT,
    txt: {
      nodeId,
      displayName,
      caps: capabilities.join(',')
    }
  })

  browser = bonjour.find({ type: 'hexmesh', protocol: 'udp' }, (svc) => {
    const remoteNodeId = svc?.txt?.nodeId
    if (!remoteNodeId || remoteNodeId === nodeId) return

    const address = Array.isArray(svc.addresses) ? svc.addresses.find((a) => a && !a.includes(':')) : ''
    if (!address) return

    const port = svc.port || UDP_PORT
    upsertPeer({
      nodeId: remoteNodeId,
      displayName: svc?.txt?.displayName || remoteNodeId,
      address,
      port,
      capabilities: (svc?.txt?.caps || '').split(',').filter(Boolean)
    })

    sendHelloTo(address, port)
  })
}

function stopMdns() {
  try {
    browser?.stop()
  } catch {}
  try {
    service?.stop()
  } catch {}
  try {
    bonjour?.destroy()
  } catch {}

  browser = null
  service = null
  bonjour = null
}

function normalizeUuid(uuid = '') {
  return String(uuid).toLowerCase().replace(/-/g, '')
}

function onBleDiscover(peripheral) {
  const serviceData = peripheral?.advertisement?.serviceData || []
  const entry = serviceData.find((item) => normalizeUuid(item?.uuid) === BLE_SERVICE_UUID_NODASH)
  if (!entry?.data) return

  const raw = entry.data.toString('utf8')
  const [remoteNodeId, remoteName] = raw.split('|', 2)
  if (!remoteNodeId || remoteNodeId === nodeId) return

  upsertPeer({
    nodeId: remoteNodeId,
    displayName: remoteName || remoteNodeId,
    address: `ble:${peripheral?.address || peripheral?.id || 'unknown'}`,
    port: -1,
    capabilities: ['ble']
  })
}

async function startBle() {
  if (!isBleEnabled() || bleActive) return

  let mod
  try {
    mod = await import('@abandonware/noble')
  } catch {
    warn('BLE disabled in helper: package @abandonware/noble is not installed.')
    return
  }

  noble = mod.default || mod
  if (!noble) return
  bleActive = true

  nobleDiscoverHandler = (peripheral) => {
    try {
      onBleDiscover(peripheral)
    } catch {}
  }

  nobleStateHandler = async (state) => {
    if (state !== 'poweredOn') return
    try {
      if (typeof noble.startScanningAsync === 'function') {
        await noble.startScanningAsync([BLE_SERVICE_UUID_NODASH], true)
      } else {
        noble.startScanning([BLE_SERVICE_UUID_NODASH], true)
      }
    } catch (error) {
      warn(`BLE scan start failed: ${error.message}`)
    }
  }

  noble.on('discover', nobleDiscoverHandler)
  noble.on('stateChange', nobleStateHandler)

  if (noble.state === 'poweredOn') {
    await nobleStateHandler('poweredOn')
  }
}

async function stopBle() {
  if (!noble) {
    bleActive = false
    return
  }

  try {
    if (typeof noble.stopScanningAsync === 'function') {
      await noble.stopScanningAsync()
    } else {
      noble.stopScanning()
    }
  } catch {}

  if (nobleDiscoverHandler) noble.removeListener('discover', nobleDiscoverHandler)
  if (nobleStateHandler) noble.removeListener('stateChange', nobleStateHandler)
  nobleDiscoverHandler = null
  nobleStateHandler = null
  noble = null
  bleActive = false
}

async function startMesh(params = {}) {
  if (running) return

  if (params.nodeId) nodeId = params.nodeId
  if (params.displayName) displayName = params.displayName
  if (params.transport) transportMode = params.transport
  if (Array.isArray(params.capabilities) && params.capabilities.length) {
    capabilities = params.capabilities
  }

  if (isLanEnabled()) {
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    socket.bind(UDP_PORT, () => {
      socket.setBroadcast(true)
      broadcastHello()
    })

    socket.on('message', onUdpMessage)
    socket.on('error', (error) => {
      emit('error', { message: `UDP error: ${error.message}` })
    })

    helloTimer = setInterval(broadcastHello, HELLO_INTERVAL_MS)
    startMdns().catch((error) => {
      warn(`mDNS helper init failed: ${error.message}`)
    })
  }

  pruneTimer = setInterval(prunePeers, 3000)

  if (isBleEnabled()) {
    await startBle()
  }

  running = true
  emit('state', { state: 'running', nodeId, udpPort: UDP_PORT, transport: transportMode })
}

async function stopMesh() {
  if (!running && !socket) return

  running = false
  clearInterval(helloTimer)
  clearInterval(pruneTimer)
  helloTimer = null
  pruneTimer = null

  stopMdns()
  await stopBle()

  try {
    socket?.close()
  } catch {}
  socket = null

  peers.clear()
  seen.clear()
  emitPeers()
  emit('state', { state: 'stopped' })
}

const wss = new WebSocketServer({ port: WS_PORT })

wss.on('connection', (ws) => {
  clients.add(ws)
  ws.send(JSON.stringify({ event: 'state', payload: { state: running ? 'running' : 'stopped', nodeId, udpPort: UDP_PORT, transport: transportMode } }))
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
      if (!isLanEnabled()) {
        emit('error', { message: 'Bridge in BLE-only mode: packet routing requires LAN/hybrid transport.' })
        return
      }
      const envelope = normalizeEnvelope(msg.payload.envelope)
      onMeshEnvelope(envelope)
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

console.log(`Mesh bridge listening on ws://0.0.0.0:${WS_PORT}`)
console.log('This helper uses mDNS + UDP + gossip. BLE scan is optional via @abandonware/noble.')
