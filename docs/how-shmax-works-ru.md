# SHMAX: как система реально работает (по текущему коду)

Документ описывает текущее состояние проекта без «планов» и без функций, которых в коде нет.

---

## 1. Что это за система сейчас

`SHMAX` — это кроссплатформенный клиент связи (Web/Desktop/Android) с такими рабочими сценариями:

- обнаружение пользователей в сети;
- личные чаты;
- создание групп и групповые чаты;
- видеозвонок 1-на-1;
- базовое сквозное шифрование личных сообщений (DH + симметричное шифрование в клиенте);
- логирование сетевых и прикладных событий в консоль.

---

## 2. Структура проекта (ключевые части)

### Клиентская часть (Vue)

- Точка входа: `/Users/tania/coding/study/hack2/src/main.js`
- Корневой UI: `/Users/tania/coding/study/hack2/src/App.vue`
- Навигация: `/Users/tania/coding/study/hack2/src/state/hashNav.js`
- Экраны:
  - `/Users/tania/coding/study/hack2/src/pages/ContactsPage.vue`
  - `/Users/tania/coding/study/hack2/src/pages/ChatsPage.vue`
  - `/Users/tania/coding/study/hack2/src/pages/ChatPage.vue`
  - `/Users/tania/coding/study/hack2/src/pages/GroupsPage.vue`
  - `/Users/tania/coding/study/hack2/src/pages/SettingsPage.vue`

### Бизнес-логика клиента

- Основной state и вся логика:  
  `/Users/tania/coding/study/hack2/src/state/useMeshApp.js`
- Транспортный слой (native/bridge):  
  `/Users/tania/coding/study/hack2/src/meshTransport.js`
- Плагин-обертка Capacitor:  
  `/Users/tania/coding/study/hack2/src/mesh.js`
- Шифрование сообщений:  
  `/Users/tania/coding/study/hack2/src/e2ee.js`
- Логирование:  
  `/Users/tania/coding/study/hack2/src/logger.js`

### Android native mesh plugin

- Реализация:  
  `/Users/tania/coding/study/hack2/android/app/src/main/java/com/tania/shmax/MeshPlugin.java`

### Desktop

- Electron main process:  
  `/Users/tania/coding/study/hack2/electron/main.cjs`
- Встроенный bridge стартует вместе с desktop-приложением.

### Отдельный backend (если используете)

- FastAPI signaling:  
  `/Users/tania/coding/study/hack2/backend/signaling-server/server.py`
- Docker Compose (signaling + coturn):  
  `/Users/tania/coding/study/hack2/backend/signaling-server/docker-compose.yml`

---

## 3. Как устроен клиентский state

В `useMeshApp.js` хранится и управляется:

- профиль пользователя (`localName`, `nodeId`);
- сетевые параметры (`bridgeUrl`, `signalRoom`, `transportMode`, STUN/TURN поля);
- состояние mesh (`meshState`, `meshError`);
- список peers (`peers`);
- группы (`groups`);
- треды чатов (`chatsByThread`, `threadMeta`);
- звонок (`callState`, `callError`, `currentCallPeerId`, `incomingCallFrom`);
- локальный и удаленный media stream;
- E2EE-состояние (сессии, ошибки/статус handshake).

Профиль и группы сохраняются в `localStorage`.

---

## 4. Как работает сеть и транспорт (подробно)

Ниже описана фактическая логика текущего кода в `meshTransport.js`, `useMeshApp.js`, `MeshPlugin.java` и `signaling/mesh-bridge.mjs`.

### 4.1 Базовые сущности сети

- **Узел (node)**: экземпляр клиента с `nodeId` и `displayName`.
- **Peer**: обнаруженный сосед в сети (хранится в `peers`).
- **Envelope**: универсальный сетевой пакет.
- **Transport mode**:
  - `lan`
  - `bluetooth`
  - `hybrid`

### 4.2 Envelope-формат и зачем каждое поле

Каждое сетевое событие упаковывается в envelope:

- `msgId` — уникальный ID сообщения (для дедупликации);
- `from` — `nodeId` отправителя;
- `to` — получатель (`peerId`) или `*` (широковещательно);
- `ttl` — число «шагов» до остановки ретрансляции;
- `type` — тип события (`CHAT`, `SIGNAL_OFFER`, `CALL_REQUEST` и т.д.);
- `payload` — полезная нагрузка;
- `sig` — поле оставлено под подпись (в текущей реализации заполняется пустой строкой).

Пример личного сообщения:

```json
{
  "msgId": "chat-1710000000000-ab12cd",
  "from": "u-a1b2c3d4",
  "to": "u-eeee1111",
  "ttl": 8,
  "type": "CHAT",
  "payload": {
    "text": "Привет",
    "ts": 1710000000000,
    "fromName": "Tania"
  },
  "sig": ""
}
```

### 4.3 Дедупликация и защита от петель

В `useMeshApp.js` есть `seen: Set`:

- если `msgId` уже был, пакет игнорируется;
- при росте `seen > 10000`, set очищается;
- это базовая защита от повторной обработки пакетов.

На bridge/plugin уровне также есть `seen` и `ttl`:

- при `ttl <= 0` ретрансляция прекращается;
- при `to === nodeId` пакет не форвардится дальше как целевой;
- для broadcast `to='*'` сообщение может идти дальше до исчерпания `ttl`.

### 4.4 Как выбирается транспорт по платформе

`createMeshTransport()`:

- Android/Native platform -> `createNativeTransport()`
- Web/Desktop -> `createBridgeTransport()`

Это значит, что UI и чатовая логика едины, а «низ сети» разный.

### 4.5 Native transport (Android) — детально

Вызовы:

- `Mesh.start({ nodeId, displayName, udpPort, capabilities, transport })`
- `Mesh.getPeers()`
- `Mesh.sendPacket({ envelope })`
- `Mesh.stop()`

События от plugin:

- `peersUpdate` -> обновляет список контактов;
- `meshPacket` -> входящий envelope;
- `error` -> отображается в `meshError`.

### 4.6 Bridge transport (Web/Desktop) — детально

WebSocket старт:

1. формируется URL;
2. если `bridgeUrl` пуст, используется fallback;
3. добавляются query-параметры `username` и `user_id`;
4. запускаются попытки подключения по списку candidate URL.

Режимы протокола в одном сокете:

- **Helper protocol**:
  - `action: start`
  - `action: getPeers`
  - `action: sendPacket`
- **Signaling protocol**:
  - `type: ping`
  - входящие: `users_list`, `user_joined`, `user_left`, `signal`
  - исходящие: `type: signal`, `target`, `data`

Это сделано для совместимости: один клиент может работать и с локальным helper, и с внешним signaling.

### 4.7 WebSocket lifecycle и ошибки

В `meshTransport.js`:

- на `onopen` выставляется `meshState=running`;
- есть timeout соединения (3 сек на попытку);
- если попытка не удалась, идет следующая;
- если все попытки неуспешны -> `Bridge websocket connection failed`.

При закрытии активного сокета:

- `meshState` уходит в `stopped`;
- список signaling peers очищается.

### 4.8 Discovery в Android plugin: что именно происходит

#### UDP discovery

- периодически отправляется `HELLO`:
  - known peers часто;
  - broadсast в подсеть реже.
- на полученный `HELLO` узел отвечает `HELLO_ACK`.
- peer заносится в map с `lastSeenMs`.

#### mDNS discovery

- сервис публикуется как `_hexmesh._udp`;
- plugin слушает анонсы чужих сервисов;
- при обнаружении peer добавляется и пингуется `HELLO`.

#### BLE discovery

- в режимах `bluetooth/hybrid` запускаются BLE advertise + scan;
- по BLE считывается минимальная peer-информация (`nodeId`, имя).
- для чатов/звонков основной канал всё равно LAN/UDP.

### 4.9 TTL, ретрансляция и маршрутизация

В bridge/plugin форвардинг работает так:

- если `to` — конкретный сосед и он известен, посылается только ему;
- иначе пакет может рассылаться известным peer’ам;
- перед форвардингом `ttl` уменьшается на 1;
- при `ttl <= 0` пакет больше не распространяется.

Это дает базовую mesh-пересылку внутри доступного графа соседей.

### 4.10 Сетевые типы сообщений (реально используемые)

- чат:
  - `CHAT`
  - `CHAT_GROUP`
- звонки:
  - `CALL_REQUEST`
  - `CALL_ACCEPT`
  - `CALL_REJECT`
  - `CALL_END`
  - `SIGNAL_OFFER`
  - `SIGNAL_ANSWER`
  - `SIGNAL_ICE`
- шифрование:
  - `E2EE_KEY_BUNDLE`
  - `E2EE_KEY_REQUEST`
- pub/sub:
  - `GOSSIP_PUBSUB`

### 4.11 Работа при обрывах

Что есть в текущем коде:

- WebSocket reconnect через список candidate URL при новом `startMesh`;
- корректный `stop` с очисткой listeners/sockets/peers;
- при потере peer connection в звонке:
  - `disconnected/failed/closed` -> завершение звонка;
  - при `failed` выставляется ошибка.

Что важно:

- автоматический бесконечный reconnect loop в фоне не реализован как отдельный механизм;
- восстановление инициируется пользователем (`Старт mesh`) или повторным стартом сценария.

---

## 5. Android MeshPlugin: пошаговый цикл работы

### 5.1 `start()`

1. читает аргументы (`nodeId`, `displayName`, `transport`, `udpPort`, `capabilities`);
2. если включен LAN:
   - открывает UDP socket;
   - поднимает receiver thread;
   - запускает scheduler;
   - стартует mDNS;
3. если включен BLE:
   - стартует BLE advertise/scan;
4. выставляет `running=true`.

### 5.2 Receiver loop

- читает UDP datagram;
- парсит JSON;
- если `HELLO/HELLO_ACK` -> обновляет peer;
- если `MESH` -> обрабатывает envelope и ретранслирует при необходимости.

### 5.3 Peer lifecycle

- peer хранится в map с `lastSeenMs`;
- scheduler периодически удаляет устаревших peers по TTL;
- после изменений отправляется `peersUpdate` в JS-слой.

### 5.4 `sendPacket()`

- принимает envelope из JS;
- нормализует поля;
- отправляет в сеть с учетом `to` и текущего списка peers.

### 5.5 `stop()`

- останавливает scheduler, receiver, mDNS, BLE, socket;
- освобождает ресурсы;
- очищает runtime-состояние transport.

---

## 6. Как работают чаты

## 6.1 Личный чат

Сообщение отправляется как envelope типа `CHAT` c `to = peerId`.

На прием:

- создается/обновляется тред `peer:<id>`;
- сообщение добавляется в историю;
- для входящих растет `unread`.

## 6.2 Групповой чат

Группа хранится как объект с:

- `id`
- `name`
- `members`
- `createdAt`

Сообщение в группу отправляется как `CHAT_GROUP` с `to='*'` и списком `memberIds`.
На прием сообщение принимают только участники группы.
Есть защита от собственного loopback-дубликата.

---

## 7. Как работает видеозвонок

Логика в `useMeshApp.js` + UI в `ChatPage.vue`.

### Сигнальные события

- `CALL_REQUEST`
- `CALL_ACCEPT`
- `CALL_REJECT`
- `CALL_END`
- `SIGNAL_OFFER`
- `SIGNAL_ANSWER`
- `SIGNAL_ICE`

### Процесс

1. Инициатор отправляет `CALL_REQUEST`.
2. Получатель принимает/отклоняет.
3. После accept: создается `RTCPeerConnection`.
4. Идут `offer/answer`.
5. Идет обмен ICE-кандидатами.
6. При подключении появляется удаленный stream.

### Что видит пользователь

Состояния: `idle`, `calling`, `ringing`, `connecting`, `in-call`, `error`.
Локальное видео в UI отзеркалено CSS (`scaleX(-1)`).

---

## 8. Как работает шифрование сообщений

Реализация в `e2ee.js`.

Что есть:

- DH-обмен ключами между peer’ами;
- формирование сессионного секрета;
- шифрование/дешифрование текста личного сообщения;
- протокольные события ключей:
  - `E2EE_KEY_BUNDLE`
  - `E2EE_KEY_REQUEST`

Если ключевой сессии еще нет, сообщение помечается как «зашифровано, ключ недоступен», и клиент пытается доустановить сессию.

---

## 9. Что показывают настройки

В `SettingsPage.vue`:

- ник;
- user id;
- `bridgeUrl` и `signalRoom` (не показываются на Android, только web/desktop);
- transport mode: `lan`, `hybrid`, `bluetooth`;
- поля STUN/TURN (`stunUrl`, `turnUrl`, `turnUsername`, `turnCredential`);
- кнопки старт/стоп mesh;
- статусы режима, транспорта и состояния mesh.

---

## 10. Логи и диагностика

Логирование сделано через `logger.js`.

Scope-префиксы:

- `SHMAX:meshTransport`
- `SHMAX:useMeshApp`

Логируются:

- старт/стоп транспорта;
- попытки ws-подключения;
- ошибки;
- отправка/прием envelope;
- ключевые этапы звонка.

`debug`-логи выключены по умолчанию.  
Включение: `localStorage.setItem('shmax_debug', '1')`

---

## 11. Что точно не заявлять как «готово»

Чтобы описание было честным:

- полноценный файловый протокол (чанки/хэши/resume) в текущем клиенте не реализован;
- полноценный production-уровень криптопротокола (OMEMO/MLS) не реализован;
- multi-hop mesh routing как завершенная функция для продакшн-сценариев не оформлен как отдельный законченный модуль с тестами.

---

## 12. Краткое резюме в одном абзаце

`SHMAX` в текущем виде — это рабочий кроссплатформенный MVP mesh-коммуникации: пользователи обнаруживаются в сети, видят друг друга в контактах, обмениваются личными и групповыми сообщениями, совершают видеозвонки 1-на-1, а личные сообщения могут передаваться в зашифрованном виде через встроенный клиентский E2EE-механизм.
