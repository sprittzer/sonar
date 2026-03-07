import { Capacitor } from '@capacitor/core'
import { computed, ref, watch } from 'vue'
import { createMeshTransport } from '../meshTransport'
import {
  initE2ee,
  getOwnPublicKeyB64,
  processKeyBundle,
  hasSession,
  onSessionEstablished,
  encryptMessage,
  decryptMessage
} from '../e2ee'

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

// Track which peers have confirmed E2EE sessions (reactive so UI can respond)
const e2eeSessions = ref(new Set())
const encryptionByThread = ref(loadJson(ENCRYPTION_PREFS_KEY, {}))
const e2eeHandshakeByPeer = ref({}) // peerId -> idle|pending|ready|failed
const e2eeErrorByPeer = ref({}) // peerId -> last error text

const isNative = Capacitor.isNativePlatform()
const persisted = loadJson(PROFILE_KEY, null)

const localName = ref(persisted?.localName || 'User')
const nodeId = ref(persisted?.nodeId || `u-${Math.random().toString(16).slice(2, 10)}`)
const bridgeUrl = ref(persisted?.bridgeUrl || 'ws://127.0.0.1:8788')
const normalizedTransport = persisted?.transportMode === 'ble' ? 'bluetooth' : persisted?.transportMode
const transportMode = ref(normalizedTransport || 'hybrid')
const stunUrl = ref(persisted?.stunUrl || 'stun:stun.l.google.com:19302')
const turnUrl = ref(persisted?.turnUrl || 'turn:openrelay.metered.ca:80')
const turnUsername = ref(persisted?.turnUsername || 'openrelayproject')
const turnCredential = ref(persisted?.turnCredential || 'openrelayproject')

watch(encryptionByThread, () => saveJson(ENCRYPTION_PREFS_KEY, encryptionByThread.value), { deep: true })
watch([localName, nodeId, bridgeUrl, transportMode, stunUrl, turnUrl, turnUsername, turnCredential], () => {
  saveJson(PROFILE_KEY, {
    localName: localName.value,
    nodeId: nodeId.value,
    bridgeUrl: bridgeUrl.value,
    transportMode: transportMode.value,
    stunUrl: stunUrl.value,
    turnUrl: turnUrl.value,
    turnUsername: turnUsername.value,
    turnCredential: turnCredential.value
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
const pendingEncryptedByPeer = new Map() // peerId -> [{ envelope, label, placeholderKey }]
let e2eeSessionListenerBound = false
let e2eeInitPromise = null
const callState = ref('idle') // idle|calling|ringing|connecting|in-call|error
const callError = ref('')
const currentCallPeerId = ref('')
const incomingCallFrom = ref('')
const localCallStream = ref(null)
const remoteCallStream = ref(null)
let peerConnection = null
let pendingRemoteIce = []

async function ensureE2eeInitialized() {
  if (e2eeInitPromise) return e2eeInitPromise
  e2eeInitPromise = initE2ee({ nodeId: nodeId.value }).catch((error) => {
    e2eeInitPromise = null
    throw error
  })
  return e2eeInitPromise
}

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
  return e2eeHandshakeByPeer.value[peerId] || 'idle'
}

function getHandshakeErrorByPeer(peerId) {
  if (!peerId) return ''
  return e2eeErrorByPeer.value[peerId] || ''
}

function getThreadEncryptionEnabled(threadKey) {
  return Boolean(encryptionByThread.value[threadKey])
}

async function ensureE2eeForPeer(peerId) {
  if (!peerId) return false
  if (hasSession(peerId)) {
    e2eeHandshakeByPeer.value[peerId] = 'ready'
    e2eeErrorByPeer.value[peerId] = ''
    e2eeSessions.value = new Set([...e2eeSessions.value, peerId])
    return true
  }

  e2eeHandshakeByPeer.value[peerId] = 'pending'
  e2eeErrorByPeer.value[peerId] = ''
  try {
    await ensureE2eeInitialized()
    if (!mesh || meshState.value !== 'running') {
      throw new Error('Mesh не запущен. Сначала нажмите "Старт mesh".')
    }
    await broadcastOwnKeyBundle(peerId)
    await requestPeerKeyBundle(peerId)
    return false
  } catch (error) {
    e2eeHandshakeByPeer.value[peerId] = 'failed'
    e2eeErrorByPeer.value[peerId] = error?.message || 'Неизвестная ошибка обмена ключами.'
    return false
  }
}

async function setThreadEncryption(threadKey, enabled) {
  if (!threadKey?.startsWith('peer:')) return
  if (enabled) {
    encryptionByThread.value = { ...encryptionByThread.value, [threadKey]: true }
    const peerId = getPeerIdFromThread(threadKey)
    await ensureE2eeForPeer(peerId)
    return
  }

  const next = { ...encryptionByThread.value }
  delete next[threadKey]
  encryptionByThread.value = next
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
      transportMode: transportMode.value,
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

    // Initialise E2EE and broadcast our public key bundle to all peers
    try {
      await ensureE2eeInitialized()

      // Re-establish sessions when another tab shares a key bundle.
      if (!e2eeSessionListenerBound) {
        onSessionEstablished((peerId) => {
          e2eeSessions.value = new Set([...e2eeSessions.value, peerId])
          e2eeHandshakeByPeer.value[peerId] = 'ready'
          e2eeErrorByPeer.value[peerId] = ''
          retryPendingEncrypted(peerId)
        })
        e2eeSessionListenerBound = true
      }

      if (mesh && meshState.value === 'running') {
        await broadcastOwnKeyBundle()
      }
    } catch (e) {
      console.warn('E2EE init failed:', e)
    }

    return true
  } catch (error) {
    meshError.value = `Mesh start error: ${error?.message || 'unknown'}`
    meshState.value = 'error'
    return false
  }
}

async function stopMesh() {
  await endVideoCall(false)
  if (mesh) {
    await mesh.stop()
    mesh = null
  }
  peers.value = []
  meshState.value = 'stopped'
}

async function sendEnvelope(envelope) {
  if (!mesh) throw new Error('Mesh is not running')
  await mesh.sendPacket(envelope)
}

function getIceServers() {
  const servers = []
  if (stunUrl.value?.trim()) {
    servers.push({ urls: stunUrl.value.trim() })
  }
  if (turnUrl.value?.trim()) {
    servers.push({
      urls: turnUrl.value.trim(),
      username: turnUsername.value?.trim() || '',
      credential: turnCredential.value?.trim() || ''
    })
  }
  return servers
}

async function ensureLocalMedia() {
  if (localCallStream.value) return localCallStream.value
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'user' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      aspectRatio: { ideal: 16 / 9 }
    },
    audio: true
  })
  localCallStream.value = stream
  return stream
}

function stopLocalMedia() {
  if (!localCallStream.value) return
  for (const track of localCallStream.value.getTracks()) {
    track.stop()
  }
  localCallStream.value = null
}

function closePeerConnection() {
  if (peerConnection) {
    peerConnection.ontrack = null
    peerConnection.onicecandidate = null
    peerConnection.onconnectionstatechange = null
    peerConnection.close()
  }
  peerConnection = null
  pendingRemoteIce = []
  remoteCallStream.value = null
}

async function ensurePeerConnection(peerId) {
  if (peerConnection && currentCallPeerId.value === peerId) return peerConnection
  closePeerConnection()

  const pc = new RTCPeerConnection({ iceServers: getIceServers() })
  peerConnection = pc
  currentCallPeerId.value = peerId

  pc.onicecandidate = (event) => {
    if (!event.candidate || !currentCallPeerId.value) return
    sendEnvelope({
      msgId: nextMsgId('ice'),
      from: nodeId.value,
      to: currentCallPeerId.value,
      ttl: 8,
      type: 'SIGNAL_ICE',
      payload: { candidate: event.candidate },
      sig: ''
    }).catch((e) => {
      callError.value = `ICE send failed: ${e?.message || 'unknown'}`
    })
  }

  pc.ontrack = (event) => {
    const [stream] = event.streams || []
    if (stream) {
      remoteCallStream.value = stream
      callState.value = 'in-call'
    }
  }

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState
    if (s === 'connected') {
      callState.value = 'in-call'
      return
    }
    if (s === 'failed' || s === 'disconnected' || s === 'closed') {
      if (s === 'failed') callError.value = 'WebRTC connection failed.'
      endVideoCall(false)
    }
  }

  const stream = await ensureLocalMedia()
  const existingKinds = new Set(pc.getSenders().map((s) => s.track?.kind).filter(Boolean))
  for (const track of stream.getTracks()) {
    if (!existingKinds.has(track.kind)) {
      pc.addTrack(track, stream)
    }
  }

  return pc
}

async function flushPendingRemoteIce() {
  if (!peerConnection || !peerConnection.remoteDescription) return
  for (const candidate of pendingRemoteIce) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
    } catch {
      // ignore malformed remote candidates
    }
  }
  pendingRemoteIce = []
}

async function startVideoCall(peerId) {
  callError.value = ''
  if (!mesh || meshState.value !== 'running') {
    throw new Error('Mesh не запущен.')
  }
  if (!peerId) throw new Error('Не выбран собеседник.')
  if (callState.value !== 'idle' && currentCallPeerId.value && currentCallPeerId.value !== peerId) {
    throw new Error('Уже есть активный звонок с другим пользователем.')
  }

  currentCallPeerId.value = peerId
  callState.value = 'calling'
  await sendEnvelope({
    msgId: nextMsgId('callreq'),
    from: nodeId.value,
    to: peerId,
    ttl: 8,
    type: 'CALL_REQUEST',
    payload: { ts: Date.now() },
    sig: ''
  })
}

async function acceptIncomingCall() {
  const peerId = incomingCallFrom.value
  if (!peerId) return
  callError.value = ''
  try {
    await ensurePeerConnection(peerId)
    callState.value = 'connecting'
    incomingCallFrom.value = ''

    await sendEnvelope({
      msgId: nextMsgId('callacc'),
      from: nodeId.value,
      to: peerId,
      ttl: 8,
      type: 'CALL_ACCEPT',
      payload: { ts: Date.now() },
      sig: ''
    })

    const offer = await peerConnection.createOffer()
    await peerConnection.setLocalDescription(offer)
    await sendEnvelope({
      msgId: nextMsgId('offer'),
      from: nodeId.value,
      to: peerId,
      ttl: 8,
      type: 'SIGNAL_OFFER',
      payload: { sdp: offer },
      sig: ''
    })
  } catch (e) {
    callState.value = 'error'
    callError.value = e?.message || 'Не удалось принять звонок.'
  }
}

async function rejectIncomingCall() {
  const peerId = incomingCallFrom.value
  incomingCallFrom.value = ''
  if (!peerId) return
  await sendEnvelope({
    msgId: nextMsgId('callrej'),
    from: nodeId.value,
    to: peerId,
    ttl: 8,
    type: 'CALL_REJECT',
    payload: { reason: 'rejected', ts: Date.now() },
    sig: ''
  })
  callState.value = 'idle'
  currentCallPeerId.value = ''
}

async function endVideoCall(notifyPeer = true) {
  const peerId = currentCallPeerId.value
  if (notifyPeer && peerId) {
    try {
      await sendEnvelope({
        msgId: nextMsgId('callend'),
        from: nodeId.value,
        to: peerId,
        ttl: 8,
        type: 'CALL_END',
        payload: { ts: Date.now() },
        sig: ''
      })
    } catch {
      // ignore
    }
  }
  closePeerConnection()
  stopLocalMedia()
  incomingCallFrom.value = ''
  currentCallPeerId.value = ''
  callState.value = 'idle'
}

async function broadcastOwnKeyBundle(targetPeerId = '*') {
  const publicKey = await getOwnPublicKeyB64()
  const env = {
    msgId: nextMsgId('kb'),
    from: nodeId.value,
    to: targetPeerId || '*',
    ttl: 8,
    type: 'E2EE_KEY_BUNDLE',
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
  const env = {
    msgId: nextMsgId('kreq'),
    from: nodeId.value,
    to: peerId,
    ttl: 8,
    type: 'E2EE_KEY_REQUEST',
    payload: {
      requestedBy: nodeId.value,
      ts: Date.now()
    },
    sig: ''
  }
  await sendEnvelope(env)
}

function queuePendingEncrypted(peerId, envelope, label, placeholderKey) {
  if (!peerId || !envelope) return
  const list = pendingEncryptedByPeer.get(peerId) || []
  list.push({ envelope, label, placeholderKey })
  pendingEncryptedByPeer.set(peerId, list)
}

function retryPendingEncrypted(peerId) {
  if (!peerId || !hasSession(peerId)) return
  const list = pendingEncryptedByPeer.get(peerId)
  if (!list?.length) return

  for (const { envelope, label, placeholderKey } of list) {
    const payload = envelope?.payload || {}
    const e2ee = payload.e2ee
    if (!e2ee?.iv || !e2ee?.ciphertext) continue

    decryptMessage(peerId, e2ee.iv, e2ee.ciphertext)
      .then((plaintext) => {
        const threadKey = `peer:${peerId}`
        const messages = chatsByThread.value[threadKey] || []
        const target = messages.find((m) => m.localKey === placeholderKey)
        if (target) {
          target.text = plaintext
          target.decryptFailed = false
          target.ts = payload.ts || target.ts || Date.now()
          target.encrypted = true
          return
        }

        pushMessage(threadKey, {
          localKey: `${envelope.msgId}-in-retry`,
          text: plaintext,
          ts: payload.ts || Date.now(),
          from: label || payload.fromName || peerId,
          outgoing: false,
          encrypted: true
        })
      })
      .catch(() => {
        // Keep original placeholder in chat if still not decryptable.
      })
  }

  pendingEncryptedByPeer.delete(peerId)
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
        await ensureE2eeForPeer(peerId)
        throw new Error('Шифрование включено, но защищенная сессия еще не готова. Подождите обмена ключами.')
      }
      try {
        const e2ee = await encryptMessage(peerId, normalized)
        payload = {
          text: '',
          ts,
          fromName: localName.value || nodeId.value,
          e2ee
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

  if (envelope.type === 'E2EE_KEY_BUNDLE') {
    const { publicKey, deviceId } = payload
    const peerId = deviceId || envelope.from
    if (peerId && publicKey) {
      processKeyBundle(peerId, publicKey)
        .then(() => {
          if (hasSession(peerId)) {
            e2eeSessions.value = new Set([...e2eeSessions.value, peerId])
            e2eeHandshakeByPeer.value[peerId] = 'ready'
            // Reply with our own key bundle so the peer can also establish a session
            broadcastOwnKeyBundle(peerId).catch((e) => console.warn('E2EE: failed to send own key bundle:', e))
            retryPendingEncrypted(peerId)
          }
        })
        .catch((e) => {
          e2eeHandshakeByPeer.value[peerId] = 'failed'
          e2eeErrorByPeer.value[peerId] = e?.message || 'Ошибка обработки key bundle.'
          console.warn('E2EE: processKeyBundle failed:', e)
        })
    }
    return
  }

  if (envelope.type === 'E2EE_KEY_REQUEST') {
    if (envelope.to && envelope.to !== '*' && envelope.to !== nodeId.value) return
    broadcastOwnKeyBundle(envelope.from).catch((e) => {
      console.warn('E2EE: failed to reply with key bundle:', e)
    })
    return
  }

  if (envelope.type === 'CALL_REQUEST') {
    if (callState.value !== 'idle' && currentCallPeerId.value && currentCallPeerId.value !== envelope.from) {
      sendEnvelope({
        msgId: nextMsgId('callbusy'),
        from: nodeId.value,
        to: envelope.from,
        ttl: 8,
        type: 'CALL_REJECT',
        payload: { reason: 'busy', ts: Date.now() },
        sig: ''
      }).catch(() => {})
      return
    }
    incomingCallFrom.value = envelope.from
    currentCallPeerId.value = envelope.from
    callState.value = 'ringing'
    return
  }

  if (envelope.type === 'CALL_ACCEPT') {
    if (envelope.from !== currentCallPeerId.value) return
    ensurePeerConnection(envelope.from)
      .then(() => {
        callState.value = 'connecting'
      })
      .catch((e) => {
        callState.value = 'error'
        callError.value = e?.message || 'Call accept handling failed.'
      })
    return
  }

  if (envelope.type === 'CALL_REJECT') {
    if (envelope.from !== currentCallPeerId.value) return
    callError.value = payload?.reason === 'busy' ? 'Собеседник занят.' : 'Собеседник отклонил звонок.'
    endVideoCall(false).catch(() => {})
    return
  }

  if (envelope.type === 'CALL_END') {
    if (envelope.from !== currentCallPeerId.value) return
    endVideoCall(false).catch(() => {})
    return
  }

  if (envelope.type === 'SIGNAL_OFFER') {
    const offer = payload?.sdp
    if (!offer) return
    ensurePeerConnection(envelope.from)
      .then(async () => {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
        await flushPendingRemoteIce()
        const answer = await peerConnection.createAnswer()
        await peerConnection.setLocalDescription(answer)
        await sendEnvelope({
          msgId: nextMsgId('answer'),
          from: nodeId.value,
          to: envelope.from,
          ttl: 8,
          type: 'SIGNAL_ANSWER',
          payload: { sdp: answer },
          sig: ''
        })
        if (callState.value !== 'in-call') callState.value = 'connecting'
      })
      .catch((e) => {
        callState.value = 'error'
        callError.value = e?.message || 'Offer handling failed.'
      })
    return
  }

  if (envelope.type === 'SIGNAL_ANSWER') {
    const answer = payload?.sdp
    if (!answer || !peerConnection) return
    peerConnection.setRemoteDescription(new RTCSessionDescription(answer))
      .then(() => flushPendingRemoteIce())
      .catch((e) => {
        callState.value = 'error'
        callError.value = e?.message || 'Answer handling failed.'
      })
    return
  }

  if (envelope.type === 'SIGNAL_ICE') {
    const candidate = payload?.candidate
    if (!candidate) return
    if (!peerConnection || !peerConnection.remoteDescription) {
      pendingRemoteIce.push(candidate)
      return
    }
    peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {})
    return
  }

  if (envelope.type === 'CHAT') {
    const threadKey = `peer:${envelope.from}`
    const peer = peers.value.find((p) => p.nodeId === envelope.from)
    const label = peer?.displayName || payload.fromName || envelope.from
    ensureThread(threadKey, label)

    if (payload.e2ee) {
      // E2EE-encrypted message
      if (hasSession(envelope.from)) {
        decryptMessage(envelope.from, payload.e2ee.iv, payload.e2ee.ciphertext)
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
            const placeholderKey = `${envelope.msgId}-in-failed`
            pushMessage(threadKey, {
              localKey: placeholderKey,
              text: '[Не удалось расшифровать сообщение]',
              ts: payload.ts || Date.now(),
              from: label,
              outgoing: false,
              encrypted: true,
              decryptFailed: true
            })
            queuePendingEncrypted(envelope.from, envelope, label, placeholderKey)
            ensureE2eeForPeer(envelope.from)
          })
      } else {
        const placeholderKey = `${envelope.msgId}-in-nosession`
        pushMessage(threadKey, {
          localKey: placeholderKey,
          text: '[Зашифрованное сообщение: сессия еще не установлена]',
          ts: payload.ts || Date.now(),
          from: label,
          outgoing: false,
          encrypted: true,
          decryptFailed: true
        })
        queuePendingEncrypted(envelope.from, envelope, label, placeholderKey)
        ensureE2eeForPeer(envelope.from)
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
    stunUrl,
    turnUrl,
    turnUsername,
    turnCredential,
    transportMode,
    meshState,
    meshError,
    peers,
    groups,
    chatThreads,
    e2eeSessions,
    getThreadEncryptionEnabled,
    setThreadEncryption,
    getHandshakeStatusByPeer,
    getHandshakeErrorByPeer,
    ensureE2eeForPeer,
    callState,
    callError,
    currentCallPeerId,
    incomingCallFrom,
    localCallStream,
    remoteCallStream,
    startVideoCall,
    acceptIncomingCall,
    rejectIncomingCall,
    endVideoCall,
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
