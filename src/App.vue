<template>
  <main class="page">
    <section class="panel">
      <h1>HEX Mesh (No Central Server)</h1>
      <p class="muted">mDNS + UDP discovery, gossip relay, mesh-signaling для WebRTC.</p>

      <div class="grid">
        <section class="card">
          <h2>1) Узел mesh</h2>
          <div class="row">
            <input v-model.trim="localName" class="input" placeholder="Имя узла" />
            <input v-model.trim="nodeId" class="input" placeholder="nodeId" />
          </div>
          <div class="row">
            <button class="btn" @click="startMesh">Старт mesh</button>
            <button class="btn danger" @click="stopMesh">Стоп mesh</button>
          </div>
          <p class="status">Mesh: <strong>{{ meshState }}</strong></p>
          <p v-if="meshError" class="error">{{ meshError }}</p>

          <h3>Найденные узлы</h3>
          <div class="peer-list">
            <button
              v-for="peer in peers"
              :key="peer.nodeId"
              class="peer-btn"
              :class="{ active: selectedPeerId === peer.nodeId }"
              @click="selectedPeerId = peer.nodeId"
            >
              {{ peer.nodeId.slice(0, 8) }} • {{ peer.address }}:{{ peer.port }}
            </button>
            <div v-if="peers.length === 0" class="placeholder">Пока узлы не найдены.</div>
          </div>
        </section>

        <section class="card">
          <h2>2) Gossip чат</h2>
          <p class="small">Сообщения идут через mesh-пакеты (ttl + dedup), даже через ретрансляторы.</p>
          <div class="chat-box">
            <div v-for="item in messages" :key="item.localKey" :class="['msg', item.outgoing ? 'out' : 'in']">
              <div class="meta">{{ item.outgoing ? 'Ты' : item.from }} • {{ formatTime(item.ts) }}</div>
              <div>{{ item.text }}</div>
            </div>
            <div v-if="messages.length === 0" class="placeholder">Нет сообщений.</div>
          </div>
          <div class="row">
            <input v-model="chatInput" class="input" placeholder="Сообщение" @keyup.enter="sendChat" />
            <button class="btn" @click="sendChat">Отправить</button>
          </div>
        </section>

        <section class="card">
          <h2>3) WebRTC звонок (mesh-signaling)</h2>
          <div class="row">
            <button class="btn" @click="startMedia">Включить AV</button>
            <button class="btn danger" @click="stopMedia">Выключить AV</button>
            <button class="btn" @click="startCall">Позвонить выбранному узлу</button>
          </div>
          <p class="status">RTC: <strong>{{ rtcState }}</strong> | active peer: <strong>{{ selectedPeerId || '-' }}</strong></p>
          <p v-if="mediaError" class="error">{{ mediaError }}</p>

          <div class="video-grid">
            <div>
              <p class="small">Локальное</p>
              <div class="video-wrap">
                <video ref="localVideoRef" class="video mirror" autoplay muted playsinline></video>
              </div>
            </div>
            <div>
              <p class="small">Удаленное</p>
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
import { onBeforeUnmount, ref } from 'vue'
import Mesh from './mesh'

const localName = ref('User')
const nodeId = ref(`n-${Math.random().toString(16).slice(2, 10)}`)
const meshState = ref('stopped')
const meshError = ref('')

const peers = ref([])
const selectedPeerId = ref('')

const chatInput = ref('')
const messages = ref([])

const localVideoRef = ref(null)
const remoteVideoRef = ref(null)
const localStream = ref(null)
const remoteStream = ref(new MediaStream())
const mediaError = ref('')

const rtcState = ref('new')

let pc = null
let peerListener = null
let packetListener = null
const seen = new Set()

function nextMsgId(prefix = 'm') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

async function startMesh() {
  meshError.value = ''

  if (!Capacitor.isNativePlatform()) {
    meshError.value = 'Mesh discovery доступен в Android APK (нативный плагин), не в браузере.'
    return
  }

  try {
    await stopMeshListeners()

    await Mesh.start({
      nodeId: nodeId.value,
      udpPort: 41234,
      capabilities: ['chat', 'signal', 'av']
    })

    peerListener = await Mesh.addListener('peersUpdate', (event) => {
      peers.value = event.peers || []
      if (!selectedPeerId.value && peers.value.length > 0) {
        selectedPeerId.value = peers.value[0].nodeId
      }
      if (selectedPeerId.value && !peers.value.some((p) => p.nodeId === selectedPeerId.value)) {
        selectedPeerId.value = ''
      }
    })

    packetListener = await Mesh.addListener('meshPacket', (event) => {
      if (!event?.envelope) return
      try {
        const envelope = JSON.parse(event.envelope)
        onMeshEnvelope(envelope)
      } catch {
        // ignore
      }
    })

    const peersRes = await Mesh.getPeers()
    peers.value = peersRes.peers || []

    meshState.value = 'running'
  } catch (error) {
    meshError.value = `Не удалось запустить mesh: ${error?.message || 'unknown'}`
    meshState.value = 'error'
  }
}

async function stopMeshListeners() {
  if (peerListener) {
    await peerListener.remove()
    peerListener = null
  }
  if (packetListener) {
    await packetListener.remove()
    packetListener = null
  }
}

async function stopMesh() {
  try {
    await stopMeshListeners()
    await Mesh.stop()
  } catch {
    // ignore
  }
  meshState.value = 'stopped'
  peers.value = []
}

async function sendEnvelope(envelope) {
  if (!Capacitor.isNativePlatform()) return
  await Mesh.sendPacket({ envelope })
}

async function sendChat() {
  const text = chatInput.value.trim()
  if (!text) return

  const envelope = {
    msgId: nextMsgId('chat'),
    from: nodeId.value,
    to: selectedPeerId.value || '*',
    ttl: 8,
    type: 'CHAT',
    payload: {
      text,
      ts: Date.now(),
      fromName: localName.value || 'User'
    },
    sig: ''
  }

  messages.value.push({
    localKey: `${envelope.msgId}-out`,
    text,
    ts: envelope.payload.ts,
    from: localName.value || nodeId.value,
    outgoing: true
  })

  chatInput.value = ''
  await sendEnvelope(envelope)
}

function ensurePeerConnection(peerId) {
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
    const senders = new Set(pc.getSenders().map((s) => s.track?.id).filter(Boolean))
    localStream.value.getTracks().forEach((track) => {
      if (!senders.has(track.id)) {
        pc.addTrack(track, localStream.value)
      }
    })
  }
}

async function startCall() {
  if (!selectedPeerId.value) {
    meshError.value = 'Выбери узел для звонка.'
    return
  }

  ensurePeerConnection(selectedPeerId.value)

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
    meshError.value = `Ошибка старта звонка: ${error?.message || 'unknown'}`
  }
}

async function onMeshEnvelope(envelope) {
  if (!envelope?.msgId || seen.has(envelope.msgId)) return
  seen.add(envelope.msgId)
  if (seen.size > 8000) seen.clear()

  const type = envelope.type
  const payload = envelope.payload || {}

  if (type === 'CHAT') {
    messages.value.push({
      localKey: `${envelope.msgId}-in`,
      text: payload.text || '',
      ts: payload.ts || Date.now(),
      from: payload.fromName || envelope.from,
      outgoing: false
    })
    return
  }

  if (type === 'SIGNAL_OFFER') {
    selectedPeerId.value = envelope.from
    ensurePeerConnection(envelope.from)

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
      meshError.value = `Ошибка обработки offer: ${error?.message || 'unknown'}`
    }
    return
  }

  if (type === 'SIGNAL_ANSWER') {
    try {
      ensurePeerConnection(envelope.from)
      await pc.setRemoteDescription(payload.sdp)
    } catch (error) {
      meshError.value = `Ошибка обработки answer: ${error?.message || 'unknown'}`
    }
    return
  }

  if (type === 'SIGNAL_ICE') {
    try {
      ensurePeerConnection(envelope.from)
      if (payload.candidate) {
        await pc.addIceCandidate(payload.candidate)
      }
    } catch {
      // race condition, можно игнорировать
    }
  }
}

async function startMedia() {
  mediaError.value = ''
  if (localStream.value) return

  const videoConstraints = {
    facingMode: { ideal: 'user' },
    width: { ideal: 1280 },
    height: { ideal: 720 },
    aspectRatio: { ideal: 16 / 9 }
  }

  try {
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: true
      })
    } catch (avError) {
      stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false
      })
      mediaError.value = `Аудио недоступно: ${avError?.name || 'Error'}: ${avError?.message || 'unknown'}`
    }

    localStream.value = stream

    if (localVideoRef.value) {
      localVideoRef.value.srcObject = stream
      await localVideoRef.value.play()
    }

    if (pc && selectedPeerId.value) {
      const existing = new Set(pc.getSenders().map((s) => s.track?.id).filter(Boolean))
      stream.getTracks().forEach((track) => {
        if (!existing.has(track.id)) {
          pc.addTrack(track, stream)
        }
      })
    }
  } catch (error) {
    mediaError.value = `Не удалось включить AV: ${error?.name || 'Error'}: ${error?.message || 'unknown'}`
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
