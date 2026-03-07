import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import { createLocalStorage, ensureBase64Globals, importFresh } from './helpers.js'

function installGlobals(storage) {
  globalThis.localStorage = storage
  ensureBase64Globals()
}

afterEach(() => {
  delete globalThis.localStorage
})

test('initE2ee requires nodeId', async () => {
  installGlobals(createLocalStorage())
  const e2ee = await importFresh('src/e2ee.js')

  await assert.rejects(e2ee.initE2ee({}), /Node id is required/)
})

test('initE2ee persists keypair and reuses it for the same node', async () => {
  const storage = createLocalStorage()
  installGlobals(storage)

  const firstLoad = await importFresh('src/e2ee.js')
  await firstLoad.initE2ee({ nodeId: 'alice' })
  const publicKey1 = await firstLoad.getOwnPublicKeyB64()

  const secondLoad = await importFresh('src/e2ee.js')
  await secondLoad.initE2ee({ nodeId: 'alice' })
  const publicKey2 = await secondLoad.getOwnPublicKeyB64()

  assert.equal(publicKey2, publicKey1)
})

test('processKeyBundle rejects invalid peer public keys', async () => {
  installGlobals(createLocalStorage())
  const e2ee = await importFresh('src/e2ee.js')

  await e2ee.initE2ee({ nodeId: 'alice' })

  await assert.rejects(e2ee.processKeyBundle('bob', 'not-a-hex'), /Invalid peer DH public key/)
  await assert.rejects(e2ee.processKeyBundle('bob', '1'), /Invalid peer DH public key/)
})

test('processKeyBundle establishes session and notifies listeners', async () => {
  installGlobals(createLocalStorage())
  const e2ee = await importFresh('src/e2ee.js')
  const established = []

  await e2ee.initE2ee({ nodeId: 'alice' })
  e2ee.onSessionEstablished((peerId) => established.push(peerId))

  await e2ee.processKeyBundle('bob', '2')

  assert.equal(e2ee.hasSession('bob'), true)
  assert.deepEqual(established, ['bob'])
})

test('encryptMessage/decryptMessage performs roundtrip with active session', async () => {
  installGlobals(createLocalStorage())
  const e2ee = await importFresh('src/e2ee.js')

  await e2ee.initE2ee({ nodeId: 'alice' })
  await e2ee.processKeyBundle('bob', '2')

  const payload = await e2ee.encryptMessage('bob', 'hello decentralized chat')

  assert.match(payload.iv, /^[0-9a-f]{24}$/)
  assert.notEqual(payload.ciphertext, 'hello decentralized chat')

  const plaintext = await e2ee.decryptMessage('bob', payload.iv, payload.ciphertext)
  assert.equal(plaintext, 'hello decentralized chat')
})

test('encrypt/decrypt fail without established session', async () => {
  installGlobals(createLocalStorage())
  const e2ee = await importFresh('src/e2ee.js')

  await e2ee.initE2ee({ nodeId: 'alice' })

  await assert.rejects(e2ee.encryptMessage('bob', 'hello'), /No key for peer bob/)
  await assert.rejects(e2ee.decryptMessage('bob', '001122', 'AA=='), /No key for peer bob/)
})

test('processKeyBundle rejects key replacement for the same peer id', async () => {
  installGlobals(createLocalStorage())
  const e2ee = await importFresh('src/e2ee.js')

  await e2ee.initE2ee({ nodeId: 'alice' })
  await e2ee.processKeyBundle('bob', '2')
  await assert.rejects(
    e2ee.processKeyBundle('bob', '3'),
    /Identity key changed for peer bob/
  )
})
