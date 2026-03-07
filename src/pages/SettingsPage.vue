<template>
  <section class="route-panel">
    <h2>Профиль и сеть</h2>
    <div class="settings-grid">
      <input v-model.trim="localName" class="input" placeholder="Твой ник" />
      <input v-model.trim="nodeId" class="input" placeholder="user id" />
      <input v-if="!isNative" v-model.trim="bridgeUrl" class="input" placeholder="пусто = ws://155.212.168.250:80" />
      <input v-if="!isNative" v-model.trim="signalRoom" class="input" placeholder="signal room (default)" />
      <select v-model="transportMode" class="input">
        <option value="lan">LAN (Wi-Fi)</option>
        <option value="hybrid">Hybrid (LAN + Bluetooth discovery)</option>
        <option value="bluetooth">Bluetooth discovery only</option>
      </select>
      <input v-model.trim="stunUrl" class="input" placeholder="stun:stun.l.google.com:19302" />
      <input v-model.trim="turnUrl" class="input" placeholder="turn:host:port" />
      <input v-model.trim="turnUsername" class="input" placeholder="TURN username" />
      <input v-model.trim="turnCredential" class="input" placeholder="TURN password" />
    </div>

    <div class="row">
      <button class="btn" @click="startMesh">Старт mesh</button>
      <button class="btn danger" @click="stopMesh">Стоп mesh</button>
    </div>

    <p class="status">Mode: <strong>{{ isNative ? 'native-apk' : 'browser-bridge' }}</strong></p>
    <p class="status">Transport: <strong>{{ transportMode }}</strong></p>
    <p class="status">Mesh: <strong>{{ meshState }}</strong></p>
    <p v-if="meshError" class="error">{{ meshError }}</p>
  </section>
</template>

<script setup>
import { useMeshApp } from '../state/useMeshApp'

const {
  isNative,
  localName,
  nodeId,
  bridgeUrl,
  signalRoom,
  transportMode,
  stunUrl,
  turnUrl,
  turnUsername,
  turnCredential,
  meshState,
  meshError,
  startMesh,
  stopMesh
} = useMeshApp()
</script>
