import { Capacitor } from '@capacitor/core'
import Mesh from './mesh'

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

function createBridgeTransport({ nodeId, displayName, capabilities, onPeers, onPacket, onState, onError, bridgeUrl, transportMode }) {
  let ws = null

  return {
    async start() {
      await this.stop()

      return new Promise((resolve, reject) => {
        ws = new WebSocket(bridgeUrl)

        const normalizedTransport = transportMode === 'ble' ? 'bluetooth' : (transportMode || 'hybrid')
        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              action: 'start',
              payload: { nodeId, displayName, capabilities, transport: normalizedTransport }
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
            onPeers(msg.payload?.peers || [])
          }

          if (msg.event === 'meshPacket') {
            onPacket(msg.payload?.envelope)
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
