import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

import { Capacitor } from '@capacitor/core'

import { importFresh } from './helpers.js'

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = FakeWebSocket.CONNECTING
    this.sent = []
    this.closed = false
    FakeWebSocket.instances.push(this)
  }

  send(data) {
    if (this.failSend) throw new Error('send failed')
    this.sent.push(String(data))
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.closed = true
    if (this.onclose) this.onclose()
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    if (this.onopen) this.onopen()
  }

  emitMessage(message) {
    const data = typeof message === 'string' ? message : JSON.stringify(message)
    if (this.onmessage) this.onmessage({ data })
  }

  emitError() {
    if (this.onerror) this.onerror(new Error('socket error'))
  }
}

let originalWebSocket
let originalIsNativePlatform

beforeEach(() => {
  originalWebSocket = globalThis.WebSocket
  originalIsNativePlatform = Capacitor.isNativePlatform
  FakeWebSocket.instances = []

  globalThis.WebSocket = FakeWebSocket
  Capacitor.isNativePlatform = () => false
})

afterEach(() => {
  Capacitor.isNativePlatform = originalIsNativePlatform

  if (typeof originalWebSocket === 'undefined') {
    delete globalThis.WebSocket
    return
  }
  globalThis.WebSocket = originalWebSocket
})

test('bridge transport starts, sends control packets, routes inbound events and stops', async () => {
  const { createMeshTransport } = await importFresh('src/meshTransport.js')

  const states = []
  const errors = []
  const peersUpdates = []
  const packets = []

  const transport = createMeshTransport({
    nodeId: 'alice',
    displayName: 'Alice',
    capabilities: ['chat'],
    bridgeUrl: 'ws://127.0.0.1:8788',
    transportMode: 'ble',
    onPeers(peers) {
      peersUpdates.push(peers)
    },
    onPacket(packet) {
      packets.push(packet)
    },
    onState(state) {
      states.push(state)
    },
    onError(message) {
      errors.push(message)
    }
  })

  const started = transport.start()
  await Promise.resolve()

  assert.equal(FakeWebSocket.instances.length, 1)

  const ws = FakeWebSocket.instances[0]
  assert.equal(ws.url, 'ws://127.0.0.1:8788/ws?username=Alice&user_id=alice')

  ws.open()
  await started

  assert.equal(ws.sent.length, 3)
  const startMessage = JSON.parse(ws.sent[0])
  const getPeersMessage = JSON.parse(ws.sent[1])
  const pingMessage = JSON.parse(ws.sent[2])

  assert.equal(startMessage.action, 'start')
  assert.equal(startMessage.payload.transport, 'bluetooth')
  assert.equal(getPeersMessage.action, 'getPeers')
  assert.equal(pingMessage.type, 'ping')

  ws.emitMessage({ event: 'state', payload: { state: 'running' } })
  ws.emitMessage({ event: 'peersUpdate', payload: { peers: [{ nodeId: 'bob', displayName: 'Bob' }] } })
  ws.emitMessage({ event: 'meshPacket', payload: { envelope: { msgId: 'in-1', type: 'CHAT' } } })
  ws.emitMessage('invalid json payload')

  assert.equal(states.includes('running'), true)
  assert.deepEqual(peersUpdates.at(-1), [{ nodeId: 'bob', displayName: 'Bob' }])
  assert.deepEqual(packets.at(-1), { msgId: 'in-1', type: 'CHAT' })

  await transport.sendPacket({ msgId: 'out-1', type: 'CHAT', to: 'bob' })
  const outboundActionMessage = JSON.parse(ws.sent.at(-2))
  const outboundSignalMessage = JSON.parse(ws.sent.at(-1))
  assert.equal(outboundActionMessage.action, 'sendPacket')
  assert.deepEqual(outboundActionMessage.payload.envelope, { msgId: 'out-1', type: 'CHAT', to: 'bob' })
  assert.equal(outboundSignalMessage.type, 'signal')

  await transport.stop()

  assert.equal(ws.closed, true)
  assert.equal(ws.sent.some((raw) => JSON.parse(raw).action === 'stop'), true)
  assert.equal(states.includes('stopped'), true)
  assert.deepEqual(errors, [])
})

test('bridge transport sendPacket fails while disconnected', async () => {
  const { createMeshTransport } = await importFresh('src/meshTransport.js')

  const transport = createMeshTransport({
    nodeId: 'alice',
    displayName: 'Alice',
    capabilities: ['chat'],
    bridgeUrl: 'ws://127.0.0.1:8788',
    onPeers() {},
    onPacket() {},
    onState() {},
    onError() {}
  })

  await assert.rejects(transport.sendPacket({ msgId: 'x' }), /Bridge is not connected/)
})

test('bridge transport start fails fast on connect timeout', async () => {
  const { createMeshTransport } = await importFresh('src/meshTransport.js')

  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn) => {
    fn()
    return 1
  }

  try {
    const transport = createMeshTransport({
      nodeId: 'alice',
      displayName: 'Alice',
      capabilities: ['chat'],
      bridgeUrl: 'ws://127.0.0.1:8788',
      onPeers() {},
      onPacket() {},
      onState() {},
      onError() {}
    })

    await assert.rejects(transport.start(), /Bridge connect timeout/)
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})

test('bridge transport forwards bridge error events to callback', async () => {
  const { createMeshTransport } = await importFresh('src/meshTransport.js')

  const errors = []

  const transport = createMeshTransport({
    nodeId: 'alice',
    displayName: 'Alice',
    capabilities: ['chat'],
    bridgeUrl: 'ws://127.0.0.1:8788',
    onPeers() {},
    onPacket() {},
    onState() {},
    onError(message) {
      errors.push(message)
    }
  })

  const started = transport.start()
  await Promise.resolve()

  const ws = FakeWebSocket.instances[0]
  ws.open()
  await started

  ws.emitMessage({ event: 'error', payload: { message: 'bridge error test' } })

  assert.deepEqual(errors, ['bridge error test'])
})
