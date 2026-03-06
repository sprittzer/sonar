import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT || 8787)
const rooms = new Map()

function roomFor(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map())
  }
  return rooms.get(roomId)
}

function broadcast(roomId, payload, exceptNodeId = null) {
  const room = rooms.get(roomId)
  if (!room) return

  const data = JSON.stringify(payload)
  for (const [nodeId, client] of room.entries()) {
    if (exceptNodeId && nodeId === exceptNodeId) continue
    if (client.ws.readyState === 1) {
      client.ws.send(data)
    }
  }
}

const wss = new WebSocketServer({ port: PORT })

wss.on('connection', (ws) => {
  let currentRoomId = null
  let currentNodeId = null

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    if (msg.type === 'join') {
      const roomId = msg.roomId || 'default'
      const nodeId = msg.nodeId
      const name = msg.name || 'Peer'
      if (!nodeId) return

      currentRoomId = roomId
      currentNodeId = nodeId

      const room = roomFor(roomId)
      room.set(nodeId, { ws, nodeId, name })

      const peers = [...room.values()]
        .filter((p) => p.nodeId !== nodeId)
        .map((p) => ({ nodeId: p.nodeId, name: p.name }))

      ws.send(JSON.stringify({ type: 'peers', peers }))

      broadcast(
        roomId,
        {
          type: 'peer-joined',
          peer: { nodeId, name }
        },
        nodeId
      )
      return
    }

    if (msg.type === 'signal') {
      if (!currentRoomId || !currentNodeId) return
      const room = rooms.get(currentRoomId)
      if (!room) return

      if (msg.to) {
        const target = room.get(msg.to)
        if (target && target.ws.readyState === 1) {
          target.ws.send(
            JSON.stringify({
              type: 'signal',
              from: currentNodeId,
              payload: msg.payload
            })
          )
        }
        return
      }

      broadcast(
        currentRoomId,
        {
          type: 'signal',
          from: currentNodeId,
          payload: msg.payload
        },
        currentNodeId
      )
    }
  })

  ws.on('close', () => {
    if (!currentRoomId || !currentNodeId) return

    const room = rooms.get(currentRoomId)
    if (!room) return

    room.delete(currentNodeId)
    broadcast(currentRoomId, { type: 'peer-left', nodeId: currentNodeId })

    if (room.size === 0) {
      rooms.delete(currentRoomId)
    }
  })
})

console.log(`LAN signaling server listening on ws://0.0.0.0:${PORT}`)
