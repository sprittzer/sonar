<template>
  <section class="route-panel">
    <h2>Профиль и сеть</h2>
    <div class="settings-grid">
      <input v-model.trim="localName" class="input" placeholder="Твой ник" />
      <input v-model.trim="nodeId" class="input" placeholder="user id" />
      <input v-if="!isNative" v-model.trim="bridgeUrl" class="input" placeholder="ws://127.0.0.1:8788" />
      <select v-model="transportMode" class="input">
        <option value="lan">LAN (Wi-Fi)</option>
        <option value="hybrid">Hybrid (LAN + BLE discovery)</option>
        <option value="ble">BLE discovery only</option>
      </select>
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

const { isNative, localName, nodeId, bridgeUrl, transportMode, meshState, meshError, startMesh, stopMesh } = useMeshApp()
</script>
