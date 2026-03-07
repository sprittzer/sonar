import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

import { importFresh } from './helpers.js'

function createFakeWindow(initialHash = '') {
  const listeners = new Map()

  const location = {
    _hash: initialHash,
    get hash() {
      return this._hash
    },
    set hash(value) {
      this._hash = String(value)
    }
  }

  return {
    location,
    addEventListener(eventName, callback) {
      listeners.set(eventName, callback)
    },
    emit(eventName) {
      const callback = listeners.get(eventName)
      if (callback) callback()
    }
  }
}

let originalWindow

beforeEach(() => {
  originalWindow = globalThis.window
})

afterEach(() => {
  if (typeof originalWindow === 'undefined') {
    delete globalThis.window
    return
  }
  globalThis.window = originalWindow
})

test('hash nav falls back to /chats on empty hash', async () => {
  globalThis.window = createFakeWindow('')

  const { useHashNav } = await importFresh('src/state/hashNav.js')
  const nav = useHashNav()

  assert.equal(nav.currentPath.value, '/chats')
  assert.equal(nav.activeSection.value, 'chats')
  assert.equal(nav.activeChatType.value, '')
  assert.equal(nav.activeChatId.value, '')
})

test('navigate updates hash and active section after hashchange', async () => {
  const fakeWindow = createFakeWindow('#contacts')
  globalThis.window = fakeWindow

  const { useHashNav } = await importFresh('src/state/hashNav.js')
  const nav = useHashNav()

  nav.navigate('groups')
  assert.equal(fakeWindow.location.hash, '/groups')

  fakeWindow.emit('hashchange')
  assert.equal(nav.currentPath.value, '/groups')
  assert.equal(nav.activeSection.value, 'groups')
})

test('chat route resolves active chat type and decoded id', async () => {
  const encodedChatId = encodeURIComponent('peer:alice/device-1')
  const fakeWindow = createFakeWindow(`#/chat/peer/${encodedChatId}`)
  globalThis.window = fakeWindow

  const { useHashNav } = await importFresh('src/state/hashNav.js')
  const nav = useHashNav()

  assert.equal(nav.activeSection.value, 'chat')
  assert.equal(nav.activeChatType.value, 'peer')
  assert.equal(nav.activeChatId.value, 'peer:alice/device-1')
})
