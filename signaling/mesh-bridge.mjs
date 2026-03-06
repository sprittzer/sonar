import dgram from 'node:dgram'
import { WebSocketServer } from 'ws'

const WS_PORT = Number(process.env.BRIDGE_PORT || 8788)
const UDP_PORT = Number(process.env.MESH_UDP_PORT || 41234)
const HELLO_INTERVAL_MS = 1500
const PEER_TTL_MS = 10000

const peers = new Map()
const seen = new Set()
const clients = new Set()

let nodeId = `n-${Math.random().toString(16).slice(2, 10)}`
let displayName = 'User'
let capabilities = ['chat', 'signal', 'av']
let running = false
let socket = null
let helloTimer = null
let pruneTimer = null
let bonjour = null
let browser = null
let service = null

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
  if (!socket) return
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
  const wrapper = { kind: 'MESH', envelope }

  if (envelope.to !== '*' && peers.has(envelope.to)) {
    const target = peers.get(envelope.to)
    sendUdp(wrapper, target.address, target.port)
    return
  }

  for (const peer of peers.values()) {
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

function startMesh(params = {}) {
  if (running) return

  if (params.nodeId) nodeId = params.nodeId
  if (params.displayName) displayName = params.displayName
  if (Array.isArray(params.capabilities) && params.capabilities.length) {
    capabilities = params.capabilities
  }

  socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  socket.bind(UDP_PORT, () => {
    socket.setBroadcast(true)
    running = true
    emit('state', { state: 'running', nodeId, udpPort: UDP_PORT })
    broadcastHello()
  })

  socket.on('message', onUdpMessage)
  socket.on('error', (error) => {
    emit('error', { message: `UDP error: ${error.message}` })
  })

  helloTimer = setInterval(broadcastHello, HELLO_INTERVAL_MS)
  pruneTimer = setInterval(prunePeers, 3000)

  startMdns().catch((error) => {
    warn(`mDNS helper init failed: ${error.message}`)
  })
}

function stopMesh() {
  if (!running && !socket) return

  running = false
  clearInterval(helloTimer)
  clearInterval(pruneTimer)
  helloTimer = null
  pruneTimer = null

  stopMdns()

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
  ws.send(JSON.stringify({ event: 'state', payload: { state: running ? 'running' : 'stopped', nodeId, udpPort: UDP_PORT } }))
  ws.send(JSON.stringify({ event: 'peersUpdate', payload: { peers: peersArray() } }))

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString('utf8'))
    } catch {
      return
    }

    if (msg.action === 'start') {
      try {
        startMesh(msg.payload || {})
      } catch (error) {
        emit('error', { message: `Start failed: ${error.message}` })
      }
      return
    }

    if (msg.action === 'stop') {
      stopMesh()
      return
    }

    if (msg.action === 'sendPacket' && msg.payload?.envelope) {
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

console.log(`Mesh bridge listening on ws://0.0.0.0:${WS_PORT}`)
console.log('This helper uses mDNS + UDP + gossip, same topology as Android APK.')
