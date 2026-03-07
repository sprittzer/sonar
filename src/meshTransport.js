import { Capacitor } from '@capacitor/core'
import Mesh from './mesh.js'

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

      await Mesh.start({ nodeId, displayName, udpPort: 41234, capabilities, transport: transportMode || 'lan' })

      peerListener = await Mesh.addListener('peersUpdate', (event) => {
        onPeers(event.peers || [])
      })

      packetListener = await Mesh.addListener('meshPacket', (event) => {
        if (!event?.envelope) return
        try {
          onPacket(JSON.parse(event.envelope))
        } catch {
          // ignore
        }
      })

      errorListener = await Mesh.addListener('error', (event) => {
        onError(event?.message || 'Native mesh error')
      })

      const res = await Mesh.getPeers()
      onPeers(res.peers || [])
      onState('running')
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
    },

    async sendPacket(envelope) {
      await Mesh.sendPacket({ envelope })
    }
  }
}

function createBridgeTransport({ nodeId, displayName, capabilities, onPeers, onPacket, onState, onError, bridgeUrl, transportMode, signalRoom }) {
  let ws = null
  let connectTimeout = null
  const signalingPeers = new Map()

  function clearConnectTimeout() {
    if (connectTimeout) {
      clearTimeout(connectTimeout)
      connectTimeout = null
    }
  }

  function normalizeWsUrl(raw) {
    const url = String(raw || '').trim()
    if (!url) return url
    if (url.startsWith('http://')) return `ws://${url.slice('http://'.length)}`
    if (url.startsWith('https://')) return `wss://${url.slice('https://'.length)}`
    return url
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

      return new Promise((resolve, reject) => {
        ws = new WebSocket(normalizeWsUrl(bridgeUrl))

        const normalizedTransport = transportMode === 'ble' ? 'bluetooth' : (transportMode || 'hybrid')
        ws.onopen = () => {
          clearConnectTimeout()
          // Protocol A: local helper bridge
          ws.send(
            JSON.stringify({
              action: 'start',
              payload: { nodeId, displayName, capabilities, transport: normalizedTransport }
            })
          )
          ws.send(JSON.stringify({ action: 'getPeers' }))

          // Protocol B: signaling server (same as signaling/lan-server.mjs)
          ws.send(
            JSON.stringify({
              type: 'join',
              roomId: signalRoom || 'default',
              nodeId,
              name: displayName
            })
          )
          resolve()
        }

        ws.onmessage = (event) => {
          let msg
          try {
            msg = JSON.parse(event.data)
          } catch {
            return
          }

          if (msg.event === 'state') {
            onState(msg.payload?.state || 'unknown')
          }

          if (msg.event === 'error') {
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

          if (msg.type === 'peer-joined' && msg.peer?.nodeId && msg.peer.nodeId !== nodeId) {
            signalingPeers.set(msg.peer.nodeId, msg.peer)
            emitSignalingPeers()
          }

          if (msg.type === 'peer-left' && msg.nodeId) {
            signalingPeers.delete(msg.nodeId)
            emitSignalingPeers()
          }

          if (msg.type === 'signal') {
            const payload = msg.payload || {}
            if (payload.kind === 'MESH' && payload.envelope) {
              onPacket(payload.envelope)
            }
          }
        }

        ws.onerror = () => {
          onError('Bridge websocket connection failed')
        }

        ws.onclose = () => {
          clearConnectTimeout()
          onState('stopped')
        }

        connectTimeout = setTimeout(() => {
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            reject(new Error('Bridge connect timeout'))
          }
        }, 3000)
      })
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
    },

    async sendPacket(envelope) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error('Bridge is not connected')
      }
      // Protocol A
      ws.send(JSON.stringify({ action: 'sendPacket', payload: { envelope } }))
      // Protocol B
      ws.send(
        JSON.stringify({
          type: 'signal',
          to: envelope?.to && envelope.to !== '*' ? envelope.to : undefined,
          payload: { kind: 'MESH', envelope }
        })
      )
    }
  }
}