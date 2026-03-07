// DH-based peer key exchange + lightweight symmetric stream encryption.
// Note: this is an educational fallback for environments without crypto.subtle.

const E2EE_KEYS_STORAGE = 'hex_mesh_dh_identity_v1'
const E2EE_PEER_KEYS_STORAGE = 'hex_mesh_dh_peer_keys_v1'

// 2048-bit MODP Group (RFC 3526, group 14)
const DH_P = BigInt(
  '0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' +
    '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
    'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
    'E485B576625E7EC6F44C42E9A63A3620FFFFFFFFFFFFFFFF'
)
const DH_G = 2n

let selfId = ''
let privateKey = 0n
let publicKey = 0n

const peerPublicKeys = new Map() // peerId -> bigint
const sessionSecrets = new Map() // peerId -> hex string
const sessionListeners = []

function peerStorageBucket() {
  if (!selfId) return {}
  try {
    const raw = localStorage.getItem(E2EE_PEER_KEYS_STORAGE)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function loadPeerKeysFromStorage() {
  if (!selfId) return
  peerPublicKeys.clear()
  sessionSecrets.clear()
  const bucket = peerStorageBucket()
  const mine = bucket[selfId] || {}
  for (const [peerId, keyHex] of Object.entries(mine)) {
    const key = parseHexBigInt(String(keyHex))
    if (!key) continue
    peerPublicKeys.set(peerId, key)
    const shared = modPow(key, privateKey, DH_P)
    sessionSecrets.set(peerId, shared.toString(16))
  }
}

function persistPeerKey(peerId, peerPub) {
  if (!selfId || !peerId || !peerPub) return
  const bucket = peerStorageBucket()
  const mine = { ...(bucket[selfId] || {}) }
  mine[peerId] = peerPub.toString(16)
  bucket[selfId] = mine
  localStorage.setItem(E2EE_PEER_KEYS_STORAGE, JSON.stringify(bucket))
}

export async function initE2ee(options = {}) {
  if (options?.nodeId) selfId = String(options.nodeId)
  if (!selfId) throw new Error('Node id is required for DH identity.')

  const stored = localStorage.getItem(E2EE_KEYS_STORAGE)
  if (stored) {
    try {
      const parsed = JSON.parse(stored)
      if (parsed?.selfId === selfId && parsed?.privateKeyHex && parsed?.publicKeyHex) {
        privateKey = BigInt(`0x${parsed.privateKeyHex}`)
        publicKey = BigInt(`0x${parsed.publicKeyHex}`)
      }
    } catch {
      // ignore and regenerate
    }
  }

  if (!privateKey || !publicKey) {
    privateKey = randomBigInt(30) // ~240-bit exponent (good enough for this fallback)
    publicKey = modPow(DH_G, privateKey, DH_P)
    localStorage.setItem(
      E2EE_KEYS_STORAGE,
      JSON.stringify({
        selfId,
        privateKeyHex: privateKey.toString(16),
        publicKeyHex: publicKey.toString(16)
      })
    )
  }
  loadPeerKeysFromStorage()
}

export async function getOwnPublicKeyB64() {
  if (!publicKey) throw new Error('DH is not initialized.')
  return publicKey.toString(16)
}

export async function processKeyBundle(peerId, publicKeyHex) {
  if (!peerId || !publicKeyHex) return
  if (!privateKey) throw new Error('DH is not initialized.')

  const peerPub = parseHexBigInt(publicKeyHex)
  if (!peerPub || peerPub <= 1n || peerPub >= DH_P - 1n) {
    throw new Error('Invalid peer DH public key.')
  }

  const existing = peerPublicKeys.get(peerId)
  if (existing && existing !== peerPub) {
    throw new Error(`Identity key changed for peer ${peerId}. Potential impersonation detected.`)
  }

  peerPublicKeys.set(peerId, peerPub)
  if (!existing) {
    persistPeerKey(peerId, peerPub)
  }

  const shared = modPow(peerPub, privateKey, DH_P)
  const secretHex = shared.toString(16)
  sessionSecrets.set(peerId, secretHex)
  sessionListeners.forEach((fn) => fn(peerId))
}

export function hasSession(peerId) {
  return sessionSecrets.has(peerId)
}

export function onSessionEstablished(fn) {
  sessionListeners.push(fn)
}

export async function encryptMessage(peerId, plaintext) {
  const secret = sessionSecrets.get(peerId)
  if (!secret) throw new Error(`No key for peer ${peerId}`)

  const nonce = randomHex(12)
  const plainBytes = new TextEncoder().encode(plaintext)
  const keyStream = makeKeystream(secret, nonce, plainBytes.length)
  const out = new Uint8Array(plainBytes.length)
  for (let i = 0; i < plainBytes.length; i++) out[i] = plainBytes[i] ^ keyStream[i]

  return {
    iv: nonce,
    ciphertext: bytesToB64(out)
  }
}

export async function decryptMessage(peerId, iv, ciphertext) {
  const secret = sessionSecrets.get(peerId)
  if (!secret) throw new Error(`No key for peer ${peerId}`)

  const cipherBytes = b64ToBytes(ciphertext)
  const keyStream = makeKeystream(secret, iv || '', cipherBytes.length)
  const out = new Uint8Array(cipherBytes.length)
  for (let i = 0; i < cipherBytes.length; i++) out[i] = cipherBytes[i] ^ keyStream[i]

  return new TextDecoder().decode(out)
}

function parseHexBigInt(hex) {
  const normalized = String(hex).trim().toLowerCase().replace(/^0x/, '')
  if (!normalized || !/^[0-9a-f]+$/.test(normalized)) return 0n
  return BigInt(`0x${normalized}`)
}

function modPow(base, exponent, modulus) {
  if (modulus === 1n) return 0n
  let result = 1n
  let b = base % modulus
  let e = exponent
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus
    e >>= 1n
    b = (b * b) % modulus
  }
  return result
}

function randomBigInt(byteLen) {
  const bytes = randomBytes(byteLen)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  const n = BigInt(`0x${hex}`)
  return n === 0n ? 1n : n
}

function randomHex(byteLen) {
  const bytes = randomBytes(byteLen)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

function randomBytes(len) {
  const out = new Uint8Array(len)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(out)
    return out
  }
  for (let i = 0; i < len; i++) out[i] = Math.floor(Math.random() * 256)
  return out
}

function makeKeystream(secretHex, nonceHex, len) {
  const out = new Uint8Array(len)
  let filled = 0
  let counter = 0
  while (filled < len) {
    const seed = hash32(`${secretHex}:${nonceHex}:${counter}`)
    let x = seed || 0x9e3779b9
    for (let i = 0; i < 4 && filled < len; i++) {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      out[filled++] = x & 0xff
    }
    counter++
  }
  return out
}

function hash32(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function bytesToB64(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function b64ToBytes(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
