import { Capacitor } from '@capacitor/core'
import { computed, ref, watch } from 'vue'
import { createMeshTransport } from '../meshTransport'
import {
  initOmemo,
  getOwnPublicKeyB64,
  processKeyBundle,
  hasSession,
  onSessionEstablished,
  encryptMessage,
  decryptMessage
} from '../omemo'

const PROFILE_KEY = 'hex_mesh_profile_v1'
const GROUPS_KEY = 'hex_mesh_groups_v1'
const ENCRYPTION_PREFS_KEY = 'hex_mesh_encryption_prefs_v1'

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}

// Track which peers have confirmed OMEMO sessions (reactive so UI can respond)
const omemoSessions = ref(new Set())
const encryptionByThread = ref(loadJson(ENCRYPTION_PREFS_KEY, {}))
const omemoHandshakeByPeer = ref({}) // peerId -> idle|pending|ready|failed
const omemoHandshakeTimers = new Map() // peerId -> { timeoutId, retryIntervalId, attempts }
let omemoReady = false
const pendingKeyRequests = [] // Queue of peerIds requesting keys before OMEMO is ready

const isNative = Capacitor.isNativePlatform()
const persisted = loadJson(PROFILE_KEY, null)

const localName = ref(persisted?.localName || 'User')
const nodeId = ref(persisted?.nodeId || `u-${Math.random().toString(16).slice(2, 10)}`)
const bridgeUrl = ref(persisted?.bridgeUrl || 'ws://127.0.0.1:8788')

watch(encryptionByThread, () => saveJson(ENCRYPTION_PREFS_KEY, encryptionByThread.value), { deep: true })
watch([localName, nodeId, bridgeUrl], () => {
  saveJson(PROFILE_KEY, {
    localName: localName.value,
    nodeId: nodeId.value,
    bridgeUrl: bridgeUrl.value
  })
})

const meshState = ref('stopped')
const meshError = ref('')
const peers = ref([])

const groups = ref(loadJson(GROUPS_KEY, []))
watch(groups, () => saveJson(GROUPS_KEY, groups.value), { deep: true })

const chatsByThread = ref({})
const threadMeta = ref({})

let mesh = null
const seen = new Set()

const chatThreads = computed(() => {
  return Object.entries(threadMeta.value)
    .map(([key, meta]) => ({
      key,
      label: meta.label,
      preview: meta.preview || 'Нет сообщений',
      unread: meta.unread || 0,
      lastTs: meta.lastTs || 0
    }))
    .sort((a, b) => b.lastTs - a.lastTs)
})

function nextMsgId(prefix = 'm') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function ensureThread(threadKey, label) {
  if (!chatsByThread.value[threadKey]) {
    chatsByThread.value[threadKey] = []
  }

  if (!threadMeta.value[threadKey]) {
    threadMeta.value[threadKey] = {
      label,
      preview: '',
      unread: 0,
      lastTs: 0
    }
  } else if (label) {
    threadMeta.value[threadKey].label = label
  }
}

function pushMessage(threadKey, msg, markUnread = true) {
  if (!threadKey) return
  ensureThread(threadKey)

  chatsByThread.value[threadKey].push(msg)

  const meta = threadMeta.value[threadKey]
  meta.preview = msg.text || ''
  meta.lastTs = msg.ts || Date.now()

  if (!msg.outgoing && markUnread) {
    meta.unread = (meta.unread || 0) + 1
  }
}

function markThreadRead(threadKey) {
  if (threadMeta.value[threadKey]) {
    threadMeta.value[threadKey].unread = 0
  }
}

function getGroupById(groupId) {
  return groups.value.find((g) => g.id === groupId) || null
}

function upsertGroup(group) {
  const idx = groups.value.findIndex((g) => g.id === group.id)
  if (idx === -1) {
    groups.value.unshift(group)
  } else {
    groups.value[idx] = { ...groups.value[idx], ...group }
  }

  ensureThread(`group:${group.id}`, group.name)
}

function createGroup(name, memberIds) {
  const normalizedName = name.trim()
  if (!normalizedName) {
    throw new Error('Укажи название группы.')
  }

  const normalizedMembers = [...new Set([nodeId.value, ...memberIds.filter(Boolean)])]
  if (normalizedMembers.length < 2) {
    throw new Error('Нужен минимум один участник кроме тебя.')
  }

  const group = {
    id: `g-${Math.random().toString(16).slice(2, 10)}`,
    name: normalizedName,
    members: normalizedMembers,
    createdAt: Date.now()
  }

  upsertGroup(group)
  return group
}

function openOrCreatePeerChat(peer) {
  const threadKey = `peer:${peer.nodeId}`
  ensureThread(threadKey, peer.displayName || peer.nodeId)
  return threadKey
}

function openOrCreateGroupChat(group) {
  upsertGroup(group)
  return `group:${group.id}`
}

function getThreadLabel(threadKey) {
  return threadMeta.value[threadKey]?.label || threadKey
}

function getMessages(threadKey) {
  return chatsByThread.value[threadKey] || []
}

function getPeerIdFromThread(threadKey) {
  if (!threadKey || !threadKey.startsWith('peer:')) return ''
  return threadKey.replace('peer:', '')
}

function getHandshakeStatusByPeer(peerId) {
  if (!peerId) return 'idle'
  if (hasSession(peerId)) return 'ready'
  return omemoHandshakeByPeer.value[peerId] || 'idle'
}

function getThreadEncryptionEnabled(threadKey) {
  return Boolean(encryptionByThread.value[threadKey])
}

function clearHandshakeTimers(peerId) {
  const timers = omemoHandshakeTimers.get(peerId)
  if (timers) {
    if (timers.timeoutId) clearTimeout(timers.timeoutId)
    if (timers.retryIntervalId) clearInterval(timers.retryIntervalId)
    omemoHandshakeTimers.delete(peerId)
  }
}

async function ensureOmemoForPeer(peerId) {
  if (!peerId) return false
  if (hasSession(peerId)) {
    clearHandshakeTimers(peerId)
    omemoHandshakeByPeer.value[peerId] = 'ready'
    omemoSessions.value = new Set([...omemoSessions.value, peerId])
    return true
  }

  // Clear any existing timers
  clearHandshakeTimers(peerId)

  omemoHandshakeByPeer.value[peerId] = 'pending'
  console.log(`[OMEMO] Starting handshake with peer ${peerId}`)

  try {
    // Send our key bundle directly to the peer
    await sendKeyBundleToPeer(peerId)
    // Request peer's key bundle
    await requestPeerKeyBundle(peerId)
    console.log(`[OMEMO] Sent initial key exchange to peer ${peerId}`)

    // Set up retry mechanism (every 3 seconds, max 3 attempts)
    let attempts = 1
    const retryIntervalId = setInterval(async () => {
      if (hasSession(peerId)) {
        clearHandshakeTimers(peerId)
        return
      }

      attempts++
      if (attempts > 3) {
        clearHandshakeTimers(peerId)
        omemoHandshakeByPeer.value[peerId] = 'failed'
        console.warn(`[OMEMO] Handshake failed after 3 attempts for peer ${peerId}`)
        return
      }

      console.log(`[OMEMO] Retry attempt ${attempts}/3 for peer ${peerId}`)
      try {
        await sendKeyBundleToPeer(peerId)
        await requestPeerKeyBundle(peerId)
      } catch (e) {
        console.warn(`[OMEMO] Retry ${attempts} failed for peer ${peerId}:`, e)
      }
    }, 3000)

    // Set up timeout (10 seconds total)
    const timeoutId = setTimeout(() => {
      if (!hasSession(peerId)) {
        clearHandshakeTimers(peerId)
        omemoHandshakeByPeer.value[peerId] = 'failed'
        console.warn(`[OMEMO] Handshake timeout (10s) for peer ${peerId}`)
      }
    }, 10000)

    omemoHandshakeTimers.set(peerId, { timeoutId, retryIntervalId, attempts })

    return false
  } catch (e) {
    clearHandshakeTimers(peerId)
    omemoHandshakeByPeer.value[peerId] = 'failed'
    console.warn(`[OMEMO] Handshake init failed for peer ${peerId}:`, e)
    return false
  }
}

async function setThreadEncryption(threadKey, enabled) {
  if (!threadKey?.startsWith('peer:')) return
  if (enabled) {
    encryptionByThread.value = { ...encryptionByThread.value, [threadKey]: true }
    const peerId = getPeerIdFromThread(threadKey)
    await ensureOmemoForPeer(peerId)
    return
  }

  const next = { ...encryptionByThread.value }
  delete next[threadKey]
  encryptionByThread.value = next

  // Clear handshake timers when encryption is disabled
  const peerId = getPeerIdFromThread(threadKey)
  if (peerId) {
    clearHandshakeTimers(peerId)
  }
}

async function startMesh() {
  meshError.value = ''

  if (!localName.value.trim()) {
    meshError.value = 'Укажи ник.'
    return false
  }

  if (!nodeId.value.trim()) {
    meshError.value = 'Укажи user id.'
    return false
  }

  try {
    await stopMesh()

    mesh = createMeshTransport({
      nodeId: nodeId.value,
      displayName: localName.value,
      capabilities: ['chat', 'signal', 'av', 'group'],
      bridgeUrl: bridgeUrl.value,
      onPeers(nextPeers) {
        peers.value = nextPeers || []

        peers.value.forEach((peer) => {
          const key = `peer:${peer.nodeId}`
          if (threadMeta.value[key]) {
            threadMeta.value[key].label = peer.displayName || peer.nodeId
          }
        })
      },
      onPacket(envelope) {
        onMeshEnvelope(envelope)
      },
      onState(state) {
        meshState.value = state
      },
      onError(message) {
        meshError.value = message
      }
    })

    await mesh.start()

    // Initialise OMEMO and broadcast our public key bundle to all peers
    try {
      await initOmemo()
      omemoReady = true
      console.log('[OMEMO] Initialised successfully')

      // Re-establish sessions when another tab shares a key bundle
      onSessionEstablished((peerId) => {
        omemoSessions.value = new Set([...omemoSessions.value, peerId])
        omemoHandshakeByPeer.value[peerId] = 'ready'
      })

      await broadcastOwnKeyBundle()

      // Process any pending key requests that arrived before OMEMO was ready
      if (pendingKeyRequests.length > 0) {
        console.log(`[OMEMO] Processing ${pendingKeyRequests.length} pending key request(s)`)
        for (const peerId of pendingKeyRequests) {
          await sendKeyBundleToPeer(peerId).catch((e) =>
            console.warn(`[OMEMO] Failed to send key bundle to queued peer ${peerId}:`, e)
          )
        }
        pendingKeyRequests.length = 0
      }
    } catch (e) {
      console.warn('OMEMO init failed:', e)
      omemoReady = false
    }

    return true
  } catch (error) {
    meshError.value = `Mesh start error: ${error?.message || 'unknown'}`
    meshState.value = 'error'
    return false
  }
}

async function stopMesh() {
  if (mesh) {
    await mesh.stop()
    mesh = null
  }
  peers.value = []
  meshState.value = 'stopped'
  omemoReady = false
  pendingKeyRequests.length = 0

  // Clear all handshake timers
  for (const peerId of omemoHandshakeTimers.keys()) {
    clearHandshakeTimers(peerId)
  }
}

async function sendEnvelope(envelope) {
  if (!mesh) throw new Error('Mesh is not running')
  await mesh.sendPacket(envelope)
}

async function broadcastOwnKeyBundle() {
  const publicKey = await getOwnPublicKeyB64()
  const env = {
    msgId: nextMsgId('kb'),
    from: nodeId.value,
    to: '*',
    ttl: 8,
    type: 'OMEMO_KEY_BUNDLE',
    payload: {
      publicKey,
      deviceId: nodeId.value,
      ts: Date.now()
    },
    sig: ''
  }
  await sendEnvelope(env)
}

async function sendKeyBundleToPeer(peerId) {
  if (!omemoReady) {
    console.warn(`[OMEMO] Cannot send key bundle to ${peerId}: OMEMO not ready yet`)
    return
  }
  const publicKey = await getOwnPublicKeyB64()
  const env = {
    msgId: nextMsgId('kb'),
    from: nodeId.value,
    to: peerId,
    ttl: 8,
    type: 'OMEMO_KEY_BUNDLE',
    payload: {
      publicKey,
      deviceId: nodeId.value,
      ts: Date.now()
    },
    sig: ''
  }
  await sendEnvelope(env)
}

async function requestPeerKeyBundle(peerId) {
  if (!omemoReady) {
    console.warn(`[OMEMO] Cannot request key bundle from ${peerId}: OMEMO not ready yet`)
    return
  }
  const env = {
    msgId: nextMsgId('kreq'),
    from: nodeId.value,
    to: peerId,
    ttl: 8,
    type: 'OMEMO_KEY_REQUEST',
    payload: { ts: Date.now() },
    sig: ''
  }
  await sendEnvelope(env)
}

async function sendChatToThread(threadKey, text) {
  const normalized = text.trim()
  if (!normalized) return

  if (threadKey.startsWith('peer:')) {
    const peerId = threadKey.replace('peer:', '')
    const ts = Date.now()
    const msgId = nextMsgId('chat')
    const secureEnabled = getThreadEncryptionEnabled(threadKey)

    let payload
    let displayText = normalized
    let encrypted = false

    if (secureEnabled) {
      if (!hasSession(peerId)) {
        await ensureOmemoForPeer(peerId)
        throw new Error('Шифрование включено, но защищенная сессия еще не готова. Подождите обмена ключами.')
      }
      try {
        const omemo = await encryptMessage(peerId, normalized)
        payload = {
          text: '',
          ts,
          fromName: localName.value || nodeId.value,
          omemo
        }
        encrypted = true
      } catch (e) {
        throw new Error(`Не удалось зашифровать сообщение: ${e?.message || 'unknown error'}`)
      }
    } else {
      payload = { text: normalized, ts, fromName: localName.value || nodeId.value }
    }

    const env = {
      msgId,
      from: nodeId.value,
      to: peerId,
      ttl: 8,
      type: 'CHAT',
      payload,
      sig: ''
    }

    pushMessage(threadKey, {
      localKey: `${msgId}-out`,
      text: displayText,
      ts,
      from: localName.value || nodeId.value,
      outgoing: true,
      encrypted
    }, false)

    await sendEnvelope(env)
    return
  }

  if (threadKey.startsWith('group:')) {
    const groupId = threadKey.replace('group:', '')
    const group = getGroupById(groupId)
    if (!group) return

    const env = {
      msgId: nextMsgId('gchat'),
      from: nodeId.value,
      to: '*',
      ttl: 8,
      type: 'CHAT_GROUP',
      payload: {
        chatId: group.id,
        groupName: group.name,
        memberIds: group.members,
        text: normalized,
        ts: Date.now(),
        fromName: localName.value || nodeId.value
      },
      sig: ''
    }

    pushMessage(threadKey, {
      localKey: `${env.msgId}-out`,
      text: normalized,
      ts: env.payload.ts,
      from: localName.value || nodeId.value,
      outgoing: true
    }, false)

    await sendEnvelope(env)
  }
}

function onMeshEnvelope(envelope) {
  if (!envelope?.msgId || seen.has(envelope.msgId)) return
  seen.add(envelope.msgId)
  if (seen.size > 10000) seen.clear()

  const payload = envelope.payload || {}

  if (envelope.type === 'OMEMO_KEY_REQUEST') {
    // Peer is requesting our key bundle – send it directly to them
    console.log(`[OMEMO] Received key request from peer ${envelope.from}`)
    if (!omemoReady) {
      console.log(`[OMEMO] Queueing key request from ${envelope.from} (OMEMO not ready yet)`)
      pendingKeyRequests.push(envelope.from)
      return
    }
    sendKeyBundleToPeer(envelope.from).catch((e) =>
      console.warn('[OMEMO] Failed to reply with key bundle:', e)
    )
    return
  }

  if (envelope.type === 'OMEMO_KEY_BUNDLE') {
    const { publicKey, deviceId } = payload
    const peerId = deviceId || envelope.from
    console.log(`[OMEMO] Received key bundle from peer ${peerId}`)
    if (peerId && publicKey) {
      processKeyBundle(peerId, publicKey)
        .then(() => {
          if (hasSession(peerId)) {
            clearHandshakeTimers(peerId)
            omemoSessions.value = new Set([...omemoSessions.value, peerId])
            omemoHandshakeByPeer.value[peerId] = 'ready'
            console.log(`[OMEMO] ✓ Session established with peer ${peerId}`)
            // Send our key bundle back if we haven't established session yet
            if (!hasSession(envelope.from)) {
              sendKeyBundleToPeer(envelope.from).catch((e) =>
                console.warn('[OMEMO] Failed to send key bundle back:', e)
              )
            }
          }
        })
        .catch((e) => {
          clearHandshakeTimers(peerId)
          omemoHandshakeByPeer.value[peerId] = 'failed'
          console.warn('[OMEMO] processKeyBundle failed:', e)
        })
    }
    return
  }

  if (envelope.type === 'CHAT') {
    const threadKey = `peer:${envelope.from}`
    const peer = peers.value.find((p) => p.nodeId === envelope.from)
    const label = peer?.displayName || payload.fromName || envelope.from
    ensureThread(threadKey, label)

    if (payload.omemo) {
      // OMEMO-encrypted message
      if (hasSession(envelope.from)) {
        decryptMessage(envelope.from, payload.omemo.iv, payload.omemo.ciphertext)
          .then((plaintext) => {
            pushMessage(threadKey, {
              localKey: `${envelope.msgId}-in`,
              text: plaintext,
              ts: payload.ts || Date.now(),
              from: label,
              outgoing: false,
              encrypted: true
            })
          })
          .catch(() => {
            pushMessage(threadKey, {
              localKey: `${envelope.msgId}-in-failed`,
              text: '[Не удалось расшифровать сообщение]',
              ts: payload.ts || Date.now(),
              from: label,
              outgoing: false,
              encrypted: true,
              decryptFailed: true
            })
          })
      } else {
        pushMessage(threadKey, {
          localKey: `${envelope.msgId}-in-nosession`,
          text: '[Зашифрованное сообщение: сессия еще не установлена]',
          ts: payload.ts || Date.now(),
          from: label,
          outgoing: false,
          encrypted: true,
          decryptFailed: true
        })
        ensureOmemoForPeer(envelope.from)
      }
      return
    }

    pushMessage(threadKey, {
      localKey: `${envelope.msgId}-in`,
      text: payload.text || '',
      ts: payload.ts || Date.now(),
      from: payload.fromName || envelope.from,
      outgoing: false,
      encrypted: false
    }, true)
    return
  }

  if (envelope.type === 'CHAT_GROUP') {
    const memberIds = Array.isArray(payload.memberIds) ? payload.memberIds : []
    if (!memberIds.includes(nodeId.value)) return

    const group = {
      id: payload.chatId,
      name: payload.groupName || 'Group',
      members: memberIds,
      createdAt: Date.now()
    }
    upsertGroup(group)

    const threadKey = `group:${group.id}`
    pushMessage(threadKey, {
      localKey: `${envelope.msgId}-in`,
      text: payload.text || '',
      ts: payload.ts || Date.now(),
      from: payload.fromName || envelope.from,
      outgoing: false
    }, true)
  }
}

export function useMeshApp() {
  return {
    isNative,
    localName,
    nodeId,
    bridgeUrl,
    meshState,
    meshError,
    peers,
    groups,
    chatThreads,
    omemoSessions,
    getThreadEncryptionEnabled,
    setThreadEncryption,
    getHandshakeStatusByPeer,
    ensureOmemoForPeer,
    startMesh,
    stopMesh,
    openOrCreatePeerChat,
    openOrCreateGroupChat,
    createGroup,
    getThreadLabel,
    getMessages,
    markThreadRead,
    sendChatToThread,
    getGroupById,
    formatTime
  }
}
