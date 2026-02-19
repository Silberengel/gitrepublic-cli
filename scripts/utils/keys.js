import { decode } from 'nostr-tools/nip19';
import { getPublicKey } from 'nostr-tools';

/**
 * Get private key bytes from nsec or hex string
 * NEVER logs or exposes the private key
 * @param {string} key - nsec string or hex private key
 * @returns {Uint8Array} - Private key bytes
 */
export function getPrivateKeyBytes(key) {
  if (!key || typeof key !== 'string') {
    throw new Error('Invalid key: key must be a string');
  }
  
  try {
    if (key.startsWith('nsec')) {
      const decoded = decode(key);
      if (decoded.type === 'nsec') {
        return decoded.data;
      }
      throw new Error('Invalid nsec format');
    } else if (/^[0-9a-fA-F]{64}$/.test(key)) {
      // Hex format
      const keyBytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        keyBytes[i] = parseInt(key.slice(i * 2, i * 2 + 2), 16);
      }
      return keyBytes;
    }
    throw new Error('Invalid key format. Use nsec or hex.');
  } catch (error) {
    // NEVER expose the key in error messages
    if (error instanceof Error && error.message.includes(key)) {
      throw new Error('Invalid key format. Use nsec or hex.');
    }
    throw error;
  }
}

/**
 * Get the public key from private key
 * @param {string} secretKey - nsec or hex private key
 * @returns {string} - Public key (hex)
 */
export function getPublicKeyFromSecret(secretKey) {
  const privateKeyBytes = getPrivateKeyBytes(secretKey);
  return getPublicKey(privateKeyBytes);
}

/**
 * Get private key from environment
 * @returns {string} - Private key
 * @throws {Error} - If no key is found
 */
export function getPrivateKeyFromEnv() {
  const secretKey = process.env.NOSTRGIT_SECRET_KEY || process.env.NOSTR_PRIVATE_KEY || process.env.NSEC;
  if (!secretKey) {
    throw new Error('NOSTRGIT_SECRET_KEY environment variable is not set');
  }
  return secretKey;
}
