// ---------------------------------------------------------------------------
// BrowserClaw — Web Crypto helpers for API key encryption
// ---------------------------------------------------------------------------

import { PBKDF2_ITERATIONS } from './config.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Derive an AES-256-GCM key from a user passphrase using PBKDF2.
 */
export async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt plaintext. Returns IV (12 bytes) prepended to ciphertext.
 */
export async function encrypt(
  key: CryptoKey,
  plaintext: string,
): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  );
  const result = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
  result.set(iv);
  result.set(new Uint8Array(ciphertext), iv.length);
  return result.buffer;
}

/**
 * Decrypt data (IV prepended to ciphertext).
 */
export async function decrypt(
  key: CryptoKey,
  data: ArrayBuffer,
): Promise<string> {
  const arr = new Uint8Array(data);
  const iv = arr.slice(0, 12);
  const ciphertext = arr.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext,
  );
  return decoder.decode(plaintext);
}

/**
 * Generate a random salt for PBKDF2.
 */
export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * Convert ArrayBuffer to base64 string for storage.
 */
export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert base64 string back to ArrayBuffer.
 */
export function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
