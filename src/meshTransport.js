import { Capacitor } from '@capacitor/core'
import Mesh from './mesh'

export function createMeshTransport(config) {
  const isNative = Capacitor.isNativePlatform()
  return isNative ? createNativeTransport(config) : createBridgeTransport(config)
}

function createNativeTransport({ nodeId, displayName, capabilities, onPeers, onPeersDelta, onPacket, onState, onError }) {
  let peerListener = null
  let packetListener = null
  let lastPeerIds = new Set()

  function emitPeers(nextPeers) {
    const peers = nextPeers || []
    const nextIds = new Set(peers.map((p) => p.nodeId).filter(Boolean))
    const added = peers.filter((p) => p?.nodeId && !lastPeerIds.has(p.nodeId))
    const removed = [...lastPeerIds].filter((id) => !nextIds.has(id))
    lastPeerIds = nextIds
    onPeers(peers)
    onPeersDelta?.(added, removed)
  }

  return {
    async start() {
      await this.stop()

      await Mesh.start({ nodeId, displayName, udpPort: 41234, capabilities })

      peerListener = await Mesh.addListener('peersUpdate', (event) => {
        emitPeers(event.peers || [])
      })

      packetListener = await Mesh.addListener('meshPacket', (event) => {
        if (!event?.envelope) return
        try {
          onPacket(JSON.parse(event.envelope))
        } catch {
          // ignore
        }
      })

      const res = await Mesh.getPeers()
      emitPeers(res.peers || [])
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
      try {
        await Mesh.stop()
      } catch {
        // ignore
      }
      lastPeerIds = new Set()
      onState('stopped')
    },

    async sendPacket(envelope) {
      await Mesh.sendPacket({ envelope })
    }
  }
}

function createBridgeTransport({ nodeId, displayName, capabilities, onPeers, onPeersDelta, onPacket, onState, onError, bridgeUrl }) {
  let ws = null
  let lastPeerIds = new Set()

  function emitPeers(nextPeers) {
    const peers = nextPeers || []
    const nextIds = new Set(peers.map((p) => p.nodeId).filter(Boolean))
    const added = peers.filter((p) => p?.nodeId && !lastPeerIds.has(p.nodeId))
    const removed = [...lastPeerIds].filter((id) => !nextIds.has(id))
    lastPeerIds = nextIds
    onPeers(peers)
    onPeersDelta?.(added, removed)
  }

  return {
    async start() {
      await this.stop()

      return new Promise((resolve, reject) => {
        ws = new WebSocket(bridgeUrl)

        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              action: 'start',
              payload: { nodeId, displayName, capabilities }
            })
          )
          ws.send(JSON.stringify({ action: 'getPeers' }))
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
            emitPeers(msg.payload?.peers || [])
          }

          if (msg.event === 'meshPacket') {
            let envelope = msg.payload?.envelope
            // Bridge may send envelope as JSON string – parse it
            if (typeof envelope === 'string') {
              try {
                envelope = JSON.parse(envelope)
              } catch {
                // ignore malformed envelope
              }
            }
            onPacket(envelope)
          }
        }

        ws.onerror = () => {
          onError('Bridge websocket connection failed')
        }

        ws.onclose = () => {
          onState('stopped')
        }

        setTimeout(() => {
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            reject(new Error('Bridge connect timeout'))
          }
        }, 3000)
      })
    },

    async stop() {
      if (ws) {
        try {
          ws.send(JSON.stringify({ action: 'stop' }))
        } catch {
          // ignore
        }
        ws.close()
        ws = null
      }
      lastPeerIds = new Set()
      onState('stopped')
    },

    async sendPacket(envelope) {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error('Bridge is not connected')
      }
      ws.send(JSON.stringify({ action: 'sendPacket', payload: { envelope } }))
    }
  }
}
