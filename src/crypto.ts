// ---------------------------------------------------------------------------
// OpenBrowserClaw — Web Crypto helpers for API key encryption
// ---------------------------------------------------------------------------
//
// Uses a non-extractable AES-256-GCM CryptoKey stored in a dedicated
// IndexedDB database.  The key cannot be read by JavaScript — the browser
// only exposes encrypt/decrypt operations.
// ---------------------------------------------------------------------------

const KEYSTORE_DB = 'obc-keystore';
const KEYSTORE_STORE = 'keys';
const KEY_ID = 'api-key-encryption';
const IV_LENGTH = 12;

// ---- Internal: keystore database ------------------------------------------

function openKeyStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(KEYSTORE_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(KEYSTORE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Retrieve the non-extractable AES-256-GCM key, creating it on first use.
 */
async function getOrCreateKey(): Promise<CryptoKey> {
  const db = await openKeyStore();

  // Try to load an existing key
  const existing = await new Promise<CryptoKey | undefined>((resolve, reject) => {
    const tx = db.transaction(KEYSTORE_STORE, 'readonly');
    const req = tx.objectStore(KEYSTORE_STORE).get(KEY_ID);
    req.onsuccess = () => resolve(req.result as CryptoKey | undefined);
    req.onerror = () => reject(req.error);
  });

  if (existing) {
    db.close();
    return existing;
  }

  // Generate a non-extractable key — it can never be read by JS
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, // extractable = false
    ['encrypt', 'decrypt'],
  );

  // Persist via structured clone (IndexedDB can store CryptoKey objects)
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(KEYSTORE_STORE, 'readwrite');
    tx.objectStore(KEYSTORE_STORE).put(key, KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  db.close();
  return key;
}

// ---- Public API -----------------------------------------------------------

/**
 * Encrypt a plaintext string → base64 (IV + ciphertext).
 */
export async function encryptValue(plaintext: string): Promise<string> {
  const key = await getOrCreateKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a base64 string (IV + ciphertext) → plaintext.
 */
export async function decryptValue(encoded: string): Promise<string> {
  const key = await getOrCreateKey();
  const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}
