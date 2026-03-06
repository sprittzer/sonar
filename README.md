# HEX Mesh Messenger (Android)

Децентрализованная схема без центрального сервера:
- mDNS discovery (`_hexmesh._udp.local`)
- UDP broadcast fallback (`HELLO` / `HELLO_ACK`)
- Gossip relay (`msgId`, `from`, `to`, `ttl`, `type`, `payload`, `sig`)
- Mesh-signaling для WebRTC (`SIGNAL_OFFER`, `SIGNAL_ANSWER`, `SIGNAL_ICE`)

## Требования

- Android устройство
- JDK 21
- Android SDK
- Node.js

## Установка

```bash
npm install
```

## Web preview (ограниченный)

```bash
npm run dev
```

Важно: discovery/mesh transport работают только в Android APK (нативный Capacitor plugin).

## Сборка APK

```bash
npm run android:apk
```

APK:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## Использование

1. Установи APK минимум на 2 устройства в одной Wi-Fi сети.
2. На каждом устройстве нажми `Старт mesh`.
3. Дождись появления узлов в списке `Найденные узлы`.
4. Выбери узел, пиши в чат (gossip packets).
5. Для звонка включи AV и нажми `Позвонить выбранному узлу`.

## Примечания

- mDNS в некоторых сетях блокируется, поэтому включен UDP fallback.
- Gossip использует `ttl` и `seen-cache` для anti-loop/dedup.
