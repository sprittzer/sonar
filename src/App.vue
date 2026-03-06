<template>
  <main class="page">
    <section class="panel">
      <h1>HEX Mesh Chat</h1>
      <p class="muted">Постоянный профиль пользователя, авто-обнаружение узлов, отдельный чат на каждого пользователя.</p>

      <div class="grid">
        <section class="card">
          <h2>1) Профиль и mesh</h2>
          <div class="row">
            <input v-model.trim="localName" class="input" placeholder="Твой ник" />
            <input v-model.trim="nodeId" class="input" placeholder="user id" />
          </div>
          <p class="small">Ник и user id сохраняются на устройстве.</p>

          <div v-if="!isNative" class="row">
            <input v-model.trim="bridgeUrl" class="input" placeholder="ws://127.0.0.1:8788" />
          </div>

          <div class="row">
            <button class="btn" @click="startMesh">Старт mesh</button>
            <button class="btn danger" @click="stopMesh">Стоп mesh</button>
          </div>

          <p class="status">Mode: <strong>{{ isNative ? 'native-apk' : 'browser-bridge' }}</strong></p>
          <p class="status">Mesh: <strong>{{ meshState }}</strong></p>
          <p v-if="meshError" class="error">{{ meshError }}</p>

          <h3>Пользователи в сети</h3>
          <div class="peer-list">
            <button
              v-for="peer in peers"
              :key="peer.nodeId"
              class="peer-btn"
              :class="{ active: selectedPeerId === peer.nodeId }"
              @click="selectedPeerId = peer.nodeId"
            >
              <div><strong>{{ peer.displayName || peer.nodeId }}</strong></div>
              <div class="small">{{ peer.nodeId.slice(0, 8) }} • {{ peer.address }}:{{ peer.port }}</div>
            </button>
            <div v-if="peers.length === 0" class="placeholder">Пользователи не найдены.</div>
          </div>
        </section>

        <section class="card">
          <h2>2) Чат</h2>
          <p class="small">Текущий собеседник: <strong>{{ selectedPeerLabel }}</strong></p>

          <div class="chat-box">
            <div v-for="item in activeMessages" :key="item.localKey" :class="['msg', item.outgoing ? 'out' : 'in']">
              <div class="meta">{{ item.outgoing ? 'Ты' : item.from }} • {{ formatTime(item.ts) }}</div>
              <div>{{ item.text }}</div>
            </div>
            <div v-if="activeMessages.length === 0" class="placeholder">Нет сообщений в этом чате.</div>
          </div>

          <div class="row">
            <input
              v-model="chatInput"
              class="input"
              placeholder="Сообщение"
              @keyup.enter="sendChat"
              :disabled="!selectedPeerId"
            />
            <button class="btn" @click="sendChat" :disabled="!selectedPeerId">Отправить</button>
          </div>
        </section>

        <section class="card">
          <h2>3) AV звонок</h2>
          <div class="row">
            <button class="btn" @click="startMedia">Включить AV</button>
            <button class="btn danger" @click="stopMedia">Выключить AV</button>
            <button class="btn" @click="startCall" :disabled="!selectedPeerId">Позвонить</button>
          </div>

          <p class="status">RTC: <strong>{{ rtcState }}</strong> | peer: <strong>{{ selectedPeerId || '-' }}</strong></p>
          <p v-if="mediaError" class="error">{{ mediaError }}</p>

          <div class="video-grid">
            <div>
              <p class="small">Local</p>
              <div class="video-wrap">
                <video ref="localVideoRef" class="video mirror" autoplay muted playsinline></video>
              </div>
            </div>
            <div>
              <p class="small">Remote</p>
              <div class="video-wrap">
                <video ref="remoteVideoRef" class="video" autoplay playsinline></video>
              </div>
            </div>
          </div>
        </section>
      </div>
    </section>
  </main>
</template>

<script setup>
import { Capacitor } from '@capacitor/core'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { createMeshTransport } from './meshTransport'

const isNative = Capacitor.isNativePlatform()
const STORAGE_KEY = 'hex_mesh_profile_v1'

function loadProfile() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function saveProfile(profile) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profile))
}

const persisted = loadProfile()
const localName = ref(persisted?.localName || 'User')
const nodeId = ref(persisted?.nodeId || `u-${Math.random().toString(16).slice(2, 10)}`)
const bridgeUrl = ref(persisted?.bridgeUrl || 'ws://127.0.0.1:8788')

watch([localName, nodeId, bridgeUrl], () => {
  saveProfile({
    localName: localName.value,
    nodeId: nodeId.value,
    bridgeUrl: bridgeUrl.value
  })
})

const meshState = ref('stopped')
const meshError = ref('')
const peers = ref([])
const selectedPeerId = ref('')

const chatInput = ref('')
const chatsByPeer = ref({})

const rtcState = ref('new')
const mediaError = ref('')

const localVideoRef = ref(null)
const remoteVideoRef = ref(null)
const localStream = ref(null)
const remoteStream = ref(new MediaStream())

let mesh = null
let pc = null
const seen = new Set()

const selectedPeer = computed(() => peers.value.find((p) => p.nodeId === selectedPeerId.value) || null)
const selectedPeerLabel = computed(() => selectedPeer.value?.displayName || selectedPeer.value?.nodeId || '-')
const activeMessages = computed(() => chatsByPeer.value[selectedPeerId.value] || [])

function nextMsgId(prefix = 'm') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function pushChat(peerId, msg) {
  if (!peerId) return
  if (!chatsByPeer.value[peerId]) {
    chatsByPeer.value[peerId] = []
  }
  chatsByPeer.value[peerId].push(msg)
}

async function startMesh() {
  meshError.value = ''

  if (!localName.value.trim()) {
    meshError.value = 'Укажи ник.'
    return
  }
  if (!nodeId.value.trim()) {
    meshError.value = 'Укажи user id.'
    return
  }

  try {
    await stopMesh()

    mesh = createMeshTransport({
      nodeId: nodeId.value,
      displayName: localName.value,
      capabilities: ['chat', 'signal', 'av'],
      bridgeUrl: bridgeUrl.value,
      onPeers(nextPeers) {
        peers.value = nextPeers || []

        if (!selectedPeerId.value && peers.value.length) {
          selectedPeerId.value = peers.value[0].nodeId
        }

        if (selectedPeerId.value && !peers.value.some((p) => p.nodeId === selectedPeerId.value)) {
          selectedPeerId.value = ''
        }
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
  } catch (error) {
    meshError.value = `Mesh start error: ${error?.message || 'unknown'}`
    meshState.value = 'error'
  }
}

async function stopMesh() {
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

async function sendChat() {
  const text = chatInput.value.trim()
  if (!text || !selectedPeerId.value) return

  const env = {
    msgId: nextMsgId('chat'),
    from: nodeId.value,
    to: selectedPeerId.value,
    ttl: 8,
    type: 'CHAT',
    payload: {
      text,
      ts: Date.now(),
      fromName: localName.value || nodeId.value
    },
    sig: ''
  }

  pushChat(selectedPeerId.value, {
    localKey: `${env.msgId}-out`,
    text,
    ts: env.payload.ts,
    from: localName.value || nodeId.value,
    outgoing: true
  })

  chatInput.value = ''
  await sendEnvelope(env)
}

function ensurePc(peerId) {
  if (pc) return

  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  })

  rtcState.value = pc.connectionState
  pc.onconnectionstatechange = () => {
    rtcState.value = pc.connectionState
  }

  pc.onicecandidate = async (event) => {
    if (!event.candidate || !peerId) return
    await sendEnvelope({
      msgId: nextMsgId('sig'),
      from: nodeId.value,
      to: peerId,
      ttl: 8,
      type: 'SIGNAL_ICE',
      payload: { candidate: event.candidate },
      sig: ''
    })
  }

  pc.ontrack = (event) => {
    event.streams[0].getTracks().forEach((track) => remoteStream.value.addTrack(track))
    if (remoteVideoRef.value) {
      remoteVideoRef.value.srcObject = remoteStream.value
      remoteVideoRef.value.play().catch(() => {})
    }
  }

  if (localStream.value) {
    const existing = new Set(pc.getSenders().map((s) => s.track?.id).filter(Boolean))
    localStream.value.getTracks().forEach((track) => {
      if (!existing.has(track.id)) pc.addTrack(track, localStream.value)
    })
  }
}

async function startCall() {
  if (!selectedPeerId.value) {
    meshError.value = 'Выбери пользователя для звонка.'
    return
  }

  ensurePc(selectedPeerId.value)

  try {
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    await sendEnvelope({
      msgId: nextMsgId('sig'),
      from: nodeId.value,
      to: selectedPeerId.value,
      ttl: 8,
      type: 'SIGNAL_OFFER',
      payload: { sdp: pc.localDescription },
      sig: ''
    })
  } catch (error) {
    meshError.value = `Call start error: ${error?.message || 'unknown'}`
  }
}

async function onMeshEnvelope(envelope) {
  if (!envelope?.msgId || seen.has(envelope.msgId)) return
  seen.add(envelope.msgId)
  if (seen.size > 10000) seen.clear()

  const payload = envelope.payload || {}

  if (envelope.type === 'CHAT') {
    pushChat(envelope.from, {
      localKey: `${envelope.msgId}-in`,
      text: payload.text || '',
      ts: payload.ts || Date.now(),
      from: payload.fromName || envelope.from,
      outgoing: false
    })
    return
  }

  if (envelope.type === 'SIGNAL_OFFER') {
    selectedPeerId.value = envelope.from
    ensurePc(envelope.from)

    try {
      await pc.setRemoteDescription(payload.sdp)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)

      await sendEnvelope({
        msgId: nextMsgId('sig'),
        from: nodeId.value,
        to: envelope.from,
        ttl: 8,
        type: 'SIGNAL_ANSWER',
        payload: { sdp: pc.localDescription },
        sig: ''
      })
    } catch (error) {
      meshError.value = `Offer process error: ${error?.message || 'unknown'}`
    }
    return
  }

  if (envelope.type === 'SIGNAL_ANSWER') {
    try {
      ensurePc(envelope.from)
      await pc.setRemoteDescription(payload.sdp)
    } catch (error) {
      meshError.value = `Answer process error: ${error?.message || 'unknown'}`
    }
    return
  }

  if (envelope.type === 'SIGNAL_ICE') {
    try {
      ensurePc(envelope.from)
      if (payload.candidate) await pc.addIceCandidate(payload.candidate)
    } catch {
      // race during startup
    }
  }
}

async function startMedia() {
  mediaError.value = ''
  if (localStream.value) return

  const video = {
    facingMode: { ideal: 'user' },
    width: { ideal: 1280 },
    height: { ideal: 720 },
    aspectRatio: { ideal: 16 / 9 }
  }

  try {
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: true })
    } catch (avError) {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false })
      mediaError.value = `Audio disabled: ${avError?.name || 'Error'}: ${avError?.message || 'unknown'}`
    }

    localStream.value = stream

    if (localVideoRef.value) {
      localVideoRef.value.srcObject = stream
      await localVideoRef.value.play()
    }

    if (pc) {
      const existing = new Set(pc.getSenders().map((s) => s.track?.id).filter(Boolean))
      stream.getTracks().forEach((track) => {
        if (!existing.has(track.id)) pc.addTrack(track, stream)
      })
    }
  } catch (error) {
    mediaError.value = `AV start failed: ${error?.name || 'Error'}: ${error?.message || 'unknown'}`
  }
}

function stopMedia() {
  if (!localStream.value) return
  localStream.value.getTracks().forEach((track) => track.stop())
  localStream.value = null
  if (localVideoRef.value) localVideoRef.value.srcObject = null
}

function cleanupRtc() {
  if (pc) {
    pc.close()
    pc = null
  }

  remoteStream.value.getTracks().forEach((track) => track.stop())
  remoteStream.value = new MediaStream()
  if (remoteVideoRef.value) remoteVideoRef.value.srcObject = null
}

onBeforeUnmount(async () => {
  stopMedia()
  cleanupRtc()
  await stopMesh()
})
</script>
