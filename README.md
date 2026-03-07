# HEX Mesh Messenger

Одна кодовая база, два режима:
- Android APK: нативный mesh plugin (mDNS + UDP + gossip)
- Browser: локальный helper bridge, который использует ту же сеть (mDNS + UDP + gossip)

## Установка

```bash
npm install
```

## Browser test через helper

1. Запусти helper:

```bash
npm run bridge:mesh
```

По умолчанию bridge поднимает WebSocket на `ws://127.0.0.1:8788`.
Для mDNS в helper (опционально) можно установить:

```bash
npm install bonjour-service
```

Без этого будет работать UDP discovery fallback (`HELLO/HELLO_ACK`).

BLE helper (desktop Bluetooth discovery + data):

```bash
npm install @abandonware/noble @abandonware/bleno
npm run bridge:ble
```

Для BLE helper в UI укажи bridge URL: `ws://127.0.0.1:8790`.

2. Запусти web UI:

```bash
npm run dev
```

3. Открой `http://localhost:6001`, в блоке Node оставь bridge URL `ws://127.0.0.1:8788`, нажми `Старт mesh`.

## Android APK

```bash
npm run android:apk
```

APK:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## Electron Desktop (web + bridge in one app)

```bash
npm run electron:dev
```

Сборка инсталляторов:

```bash
npm run electron:dist:win
npm run electron:dist:linux
```

В desktop-сборку включены только web-часть, Electron runtime и `mesh-bridge`.
Android/Java chain в desktop пакет не включается.

## Протокол

- discovery: mDNS (`_hexmesh._udp.local`) + UDP `HELLO/HELLO_ACK`
- gossip envelope: `msgId, from, to, ttl, type, payload, sig`
- dedup: `seen-cache`
- relay: multi-hop через `ttl`
- WebRTC signaling: `SIGNAL_OFFER`, `SIGNAL_ANSWER`, `SIGNAL_ICE`
