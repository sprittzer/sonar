import { Capacitor } from '@capacitor/core'
import Mesh from './mesh.js'
import { createLogger } from './logger'

const DEFAULT_SIGNAL_HOST = '155.212.168.250'
const log = createLogger('meshTransport')

export function createMeshTransport(config) {
  const isNative = Capacitor.isNativePlatform()
  return isNative ? createNativeTransport(config) : createBridgeTransport(config)
}

function createNativeTransport({ nodeId, displayName, capabilities, onPeers, onPacket, onState, onError, transportMode }) {
  let peerListener = null
  let packetListener = null
  let errorListener = null

  return {
    async start() {
      await this.stop()
      log.info('native start', { nodeId, displayName, transportMode: transportMode || 'lan' })

      await Mesh.start({ nodeId, displayName, udpPort: 41234, capabilities, transport: transportMode || 'lan' })

      peerListener = await Mesh.addListener('peersUpdate', (event) => {
        log.debug('native peersUpdate', { count: (event.peers || []).length })
        onPeers(event.peers || [])
      })

      packetListener = await Mesh.addListener('meshPacket', (event) => {
        if (!event?.envelope) return
        try {
          log.debug('native meshPacket')
          onPacket(JSON.parse(event.envelope))
        } catch {
          // ignore
        }
      })

      errorListener = await Mesh.addListener('error', (event) => {
        log.error('native error', event?.message || 'Native mesh error')
        onError(event?.message || 'Native mesh error')
      })

      const res = await Mesh.getPeers()
      onPeers(res.peers || [])
      onState('running')
      log.info('native running', { peers: (res.peers || []).length })
    },

    async stop() {
      if (peerListener) {
        await peerListener.remove()
        peerListener = null
      }
      if (packetListener) {
        await packetListener.remove()
        packetListener = null
      }
      if (errorListener) {
        await errorListener.remove()
        errorListener = null
      }
      try {
        await Mesh.stop()
      } catch {
        // ignore
      }
      onState('stopped')
      log.info('native stopped')
    },

    async sendPacket(envelope) {
      log.debug('native sendPacket', { type: envelope?.type, to: envelope?.to, msgId: envelope?.msgId })
      await Mesh.sendPacket({ envelope })
    }
  }
}

function createBridgeTransport({ nodeId, displayName, capabilities, onPeers, onPacket, onState, onError, bridgeUrl, transportMode, signalRoom }) {
  let ws = null
  let connectTimeout = null
  const signalingPeers = new Map()
  let resolved = false

  function clearConnectTimeout() {
    if (connectTimeout) {
      clearTimeout(connectTimeout)
      connectTimeout = null
    }
  }

  function normalizeWsUrl(raw) {
    const url = String(raw || '').trim()
    if (!url) return ''
    if (url.startsWith('http://')) return `ws://${url.slice('http://'.length)}`
    if (url.startsWith('https://')) return `wss://${url.slice('https://'.length)}`
    return url
  }

  function candidateUrls(raw) {
    const normalized = normalizeWsUrl(raw)
    if (normalized) return [normalized]
    return [
      // `wss://${DEFAULT_SIGNAL_HOST}:80/ws`,
      // `ws://${DEFAULT_SIGNAL_HOST}:80/ws`,
      `wss://${DEFAULT_SIGNAL_HOST}/ws`,
      // `ws://${DEFAULT_SIGNAL_HOST}/ws`
    ]
  }

  function withServerQuery(url) {
    try {
      const u = new URL(url)
      if (u.pathname === '/' || !u.pathname) {
        u.pathname = '/ws'
      }
      if (!u.searchParams.get('username')) {
        u.searchParams.set('username', displayName || nodeId)
      }
      if (!u.searchParams.get('user_id')) {
        u.searchParams.set('user_id', nodeId)
      }
      return u.toString()
    } catch {
      return url
    }
  }

  function emitSignalingPeers() {
    const peers = [...signalingPeers.values()].map((p) => ({
      nodeId: p.nodeId,
      displayName: p.name || p.displayName || p.nodeId,
      address: p.address || 'signal-server',
      port: p.port || -1,
      capabilities: p.capabilities || ['signal'],
      lastSeenMs: Date.now()
    }))
    onPeers(peers)
  }

  return {
    async start() {
      await this.stop()
      resolved = false

      const explicitUrl = String(bridgeUrl || '').trim()
      const isHelperMode = Boolean(explicitUrl)
      const normalizedTransport = transportMode === 'ble' ? 'bluetooth' : (transportMode || 'hybrid')
      const urls = candidateUrls(bridgeUrl).map((u) => withServerQuery(u))
      let lastError = null
      log.info('bridge start', { nodeId, displayName, isHelperMode, transport: normalizedTransport, urls })

      for (const url of urls) {
        try {
          log.info('bridge connect attempt', { url })
          await new Promise((resolve, reject) => {
            const socket = new WebSocket(url)
            let opened = false
            let settled = false

            const fail = (err) => {
              if (settled) return
              settled = true
              log.warn('bridge connect failed', { url, reason: err?.message || 'unknown' })
              try {
                socket.close()
              } catch {
                // ignore
              }
              reject(err)
            }

            const succeed = () => {
              if (settled) return
              settled = true
              ws = socket
              resolved = true
              onState('running')
              log.info('bridge connected', { url })
              resolve()
            }

            socket.onopen = () => {
              opened = true
              clearConnectTimeout()
              if (isHelperMode) {
                socket.send(
                  JSON.stringify({
                    action: 'start',
                    payload: { nodeId, displayName, capabilities, transport: normalizedTransport }
                  })
                )
                socket.send(JSON.stringify({ action: 'getPeers' }))
              }
              socket.send(JSON.stringify({ type: 'ping' }))
              succeed()
            }

            socket.onmessage = (event) => {
              let msg
              try {
                msg = JSON.parse(event.data)
              } catch {
                return
              }

              if (msg.event === 'state') {
                log.debug('bridge state event', { state: msg.payload?.state || 'unknown' })
                onState(msg.payload?.state || 'unknown')
              }
              if (msg.event === 'error') {
                log.error('bridge event error', msg.payload?.message || 'bridge error')
                onError(msg.payload?.message || 'bridge error')
              }
              if (msg.event === 'peersUpdate') {
                onPeers(msg.payload?.peers || [])
              }
              if (msg.event === 'meshPacket') {
                onPacket(msg.payload?.envelope)
              }

              if (msg.type === 'peers') {
                signalingPeers.clear()
                for (const p of msg.peers || []) {
                  if (!p?.nodeId || p.nodeId === nodeId) continue
                  signalingPeers.set(p.nodeId, p)
                }
                emitSignalingPeers()
              }
              if (msg.type === 'users_list') {
                signalingPeers.clear()
                for (const p of msg.users || []) {
                  const pid = p?.id
                  if (!pid || pid === nodeId) continue
                  signalingPeers.set(pid, {
                    nodeId: pid,
                    name: p.name || pid,
                    capabilities: ['signal']
                  })
                }
                emitSignalingPeers()
              }
              if (msg.type === 'peer-joined' && msg.peer?.nodeId && msg.peer.nodeId !== nodeId) {
                signalingPeers.set(msg.peer.nodeId, msg.peer)
                emitSignalingPeers()
              }
              if (msg.type === 'user_joined' && msg.user?.id && msg.user.id !== nodeId) {
                signalingPeers.set(msg.user.id, {
                  nodeId: msg.user.id,
                  name: msg.user.name || msg.user.id,
                  capabilities: ['signal']
                })
                emitSignalingPeers()
              }
              if (msg.type === 'peer-left' && msg.nodeId) {
                signalingPeers.delete(msg.nodeId)
                emitSignalingPeers()
              }
              if (msg.type === 'user_left' && msg.user_id) {
                signalingPeers.delete(msg.user_id)
                emitSignalingPeers()
              }
              if (msg.type === 'signal') {
                const payload = msg.payload || msg.data || {}
                if (payload.kind === 'MESH' && payload.envelope) {
                  onPacket(payload.envelope)
                }
              }
            }

            socket.onerror = () => {
              if (!opened) {
                fail(new Error(`WebSocket error (${url})`))
              }
            }

            socket.onclose = () => {
              clearConnectTimeout()
              if (!opened) {
                fail(new Error(`Bridge closed before open (${url})`))
                return
              }
              if (ws === socket) {
                ws = null
                onState('stopped')
                log.warn('bridge closed', { url })
              }
            }

            connectTimeout = setTimeout(() => fail(new Error(`Bridge connect timeout (${url})`)), 3000)
          })
          return
        } catch (err) {
          lastError = err
          resolved = false
          ws = null
          log.warn('bridge attempt failed', { url, error: err?.message || 'unknown' })
        }
      }

      onError('Bridge websocket connection failed')
      log.error('bridge start failed', lastError?.message || 'Bridge websocket connection failed')
      throw (lastError || new Error('Bridge websocket connection failed'))
    },

    async stop() {
      clearConnectTimeout()
      if (ws) {
        try {
          ws.send(JSON.stringify({ action: 'stop' }))
        } catch {
          // ignore
        }
        ws.close()
        ws = null
      }
      signalingPeers.clear()
      onState('stopped')
      log.info('bridge stopped')
    },

    async sendPacket(envelope) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        log.error('bridge sendPacket while disconnected', { type: envelope?.type, to: envelope?.to })
        throw new Error('Bridge is not connected')
      }
      log.debug('bridge sendPacket', { type: envelope?.type, to: envelope?.to, msgId: envelope?.msgId })
      // Protocol A
      ws.send(JSON.stringify({ action: 'sendPacket', payload: { envelope } }))
      // Protocol B
      const directTarget = envelope?.to && envelope.to !== '*' ? envelope.to : null
      if (directTarget) {
        ws.send(
          JSON.stringify({
            type: 'signal',
            target: directTarget,
            data: { kind: 'MESH', envelope }
          })
        )
      } else {
        for (const peerId of signalingPeers.keys()) {
          ws.send(
            JSON.stringify({
              type: 'signal',
              target: peerId,
              data: { kind: 'MESH', envelope }
            })
          )
        }
      }
    }
  }
}
