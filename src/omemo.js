/**
 * OMEMO-like End-to-End Encryption
 *
 * Implements E2E encryption for peer chats using:
 *  - ECDH P-256  – identity key pair generation and session key derivation
 *  - AES-GCM 256 – per-message symmetric encryption
 *  - BroadcastChannel – synchronises key bundles across browser tabs
 *
 * Key exchange flow:
 *  1. Each node generates a persistent ECDH identity key pair (stored in localStorage).
 *  2. On connect the node broadcasts its public key as an OMEMO_KEY_BUNDLE mesh envelope.
 *  3. When a peer's key bundle is received, an ECDH shared secret is derived and an
 *     AES-GCM session key is stored for that peer.
 *  4. Subsequent CHAT messages to that peer include an `omemo` field in their payload
 *     instead of plaintext; the recipient decrypts with the matching session key.
 *  5. BroadcastChannel propagates received key bundles to other open browser tabs so
 *     all tabs share the same session state.
 */

const OMEMO_KEYS_STORAGE = 'hex_mesh_omemo_keys_v1'

// In-memory state
let _identityKeyPair = null          // { privateKey, publicKey } CryptoKey pair
const _sessionKeys = new Map()       // peerId -> CryptoKey (AES-GCM)
const _pendingBundles = new Map()    // peerId -> publicKeyB64 (received before init)

// Listeners notified when a new session is established (used by useMeshApp)
const _sessionListeners = []

// ---------------------------------------------------------------------------
// BroadcastChannel – cross-tab key-bundle sync
// ---------------------------------------------------------------------------
const _bc =
  typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('hex_omemo_key_bundles')
    : null

if (_bc) {
  _bc.onmessage = (event) => {
    const { type, peerId, publicKeyB64 } = event.data || {}
    if (type === 'KEY_BUNDLE' && peerId && publicKeyB64) {
      _handleIncomingBundle(peerId, publicKeyB64, false /* don't re-broadcast */)
    }
  }
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Initialise OMEMO: load or generate the identity key pair.
 * Must be called before any other function.
 */
export async function initOmemo() {
  const stored = localStorage.getItem(OMEMO_KEYS_STORAGE)
  if (stored) {
    try {
      const { privateKeyJwk, publicKeyJwk } = JSON.parse(stored)
      const privateKey = await crypto.subtle.importKey(
        'jwk',
        privateKeyJwk,
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits']
      )
      const publicKey = await crypto.subtle.importKey(
        'jwk',
        publicKeyJwk,
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        []
      )
      _identityKeyPair = { privateKey, publicKey }
    } catch {
      _identityKeyPair = null
    }
  }

  if (!_identityKeyPair) {
    _identityKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    )
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', _identityKeyPair.privateKey)
    const publicKeyJwk = await crypto.subtle.exportKey('jwk', _identityKeyPair.publicKey)
    localStorage.setItem(
      OMEMO_KEYS_STORAGE,
      JSON.stringify({ privateKeyJwk, publicKeyJwk })
    )
  }

  // Process any bundles that arrived before init completed
  for (const [peerId, publicKeyB64] of _pendingBundles) {
    await _handleIncomingBundle(peerId, publicKeyB64, false)
  }
  _pendingBundles.clear()
}

// ---------------------------------------------------------------------------
// Own public key
// ---------------------------------------------------------------------------

/**
 * Returns the node's own ECDH public key encoded as a base-64 string (raw format).
 */
export async function getOwnPublicKeyB64() {
  if (!_identityKeyPair) throw new Error('OMEMO not initialised')
  const raw = await crypto.subtle.exportKey('raw', _identityKeyPair.publicKey)
  return _ab2b64(raw)
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/**
 * Process a peer's key bundle (base-64 raw ECDH public key) and derive an
 * AES-GCM session key.  Safe to call multiple times for the same peer.
 *
 * @param {string} peerId       – the peer's nodeId
 * @param {string} publicKeyB64 – base-64 encoded raw ECDH P-256 public key
 */
export async function processKeyBundle(peerId, publicKeyB64) {
  if (!peerId || !publicKeyB64) return

  if (!_identityKeyPair) {
    // Queue for after init
    _pendingBundles.set(peerId, publicKeyB64)
    return
  }

  await _handleIncomingBundle(peerId, publicKeyB64, true /* broadcast to other tabs */)
}

/** Returns true if an active session exists for the given peer. */
export function hasSession(peerId) {
  return _sessionKeys.has(peerId)
}

/**
 * Register a callback that is invoked whenever a new session is established.
 * @param {(peerId: string) => void} fn
 */
export function onSessionEstablished(fn) {
  _sessionListeners.push(fn)
}

// ---------------------------------------------------------------------------
// Encryption / Decryption
// ---------------------------------------------------------------------------

/**
 * Encrypt `plaintext` for `peerId`.
 * @returns {{ iv: string, ciphertext: string }} – both values are base-64 encoded
 * @throws if no session exists for the peer
 */
export async function encryptMessage(peerId, plaintext) {
  const sessionKey = _sessionKeys.get(peerId)
  if (!sessionKey) throw new Error(`No OMEMO session for ${peerId}`)

  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sessionKey, encoded)

  return { iv: _ab2b64(iv), ciphertext: _ab2b64(ciphertext) }
}

/**
 * Decrypt a message received from `peerId`.
 * @param {string} peerId
 * @param {string} iv          – base-64 encoded IV
 * @param {string} ciphertext  – base-64 encoded ciphertext
 * @returns {string} plaintext
 * @throws if no session exists or decryption fails
 */
export async function decryptMessage(peerId, iv, ciphertext) {
  const sessionKey = _sessionKeys.get(peerId)
  if (!sessionKey) throw new Error(`No OMEMO session for ${peerId}`)

  const ivBytes = _b642ab(iv)
  const ctBytes = _b642ab(ciphertext)

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes },
    sessionKey,
    ctBytes
  )
  return new TextDecoder().decode(plaintext)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function _handleIncomingBundle(peerId, publicKeyB64, rebroadcast) {
  if (_sessionKeys.has(peerId)) return // session already exists

  try {
    const raw = _b642ab(publicKeyB64)
    const peerPublicKey = await crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    )

    const sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerPublicKey },
      _identityKeyPair.privateKey,
      256
    )

    const sessionKey = await crypto.subtle.importKey(
      'raw',
      sharedBits,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    )

    _sessionKeys.set(peerId, sessionKey)

    // Notify listeners
    _sessionListeners.forEach((fn) => fn(peerId))

    // Propagate to other browser tabs
    if (rebroadcast && _bc) {
      _bc.postMessage({ type: 'KEY_BUNDLE', peerId, publicKeyB64 })
    }
  } catch (e) {
    console.warn('OMEMO: failed to process key bundle for', peerId, e)
  }
}

function _ab2b64(bufferOrView) {
  const bytes = bufferOrView instanceof ArrayBuffer
    ? new Uint8Array(bufferOrView)
    : new Uint8Array(bufferOrView.buffer, bufferOrView.byteOffset, bufferOrView.byteLength)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function _b642ab(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
