import { createHash } from 'crypto';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { KIND_NIP98_AUTH } from '../config.js';
import { getPrivateKeyBytes } from './keys.js';

/**
 * Create NIP-98 authentication header
 */
export function createNIP98Auth(url, method, body = null) {
  const secretKey = process.env.NOSTRGIT_SECRET_KEY || process.env.NOSTR_PRIVATE_KEY || process.env.NSEC;
  if (!secretKey) {
    throw new Error('NOSTRGIT_SECRET_KEY environment variable is not set');
  }

  const privateKeyBytes = getPrivateKeyBytes(secretKey);
  const pubkey = getPublicKey(privateKeyBytes);

  // Normalize URL (remove trailing slash)
  const normalizedUrl = url.replace(/\/$/, '');

  const tags = [
    ['u', normalizedUrl],
    ['method', method.toUpperCase()]
  ];

  if (body) {
    const bodyHash = createHash('sha256').update(typeof body === 'string' ? body : JSON.stringify(body)).digest('hex');
    tags.push(['payload', bodyHash]);
  }

  const eventTemplate = {
    kind: KIND_NIP98_AUTH,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags
  };

  const signedEvent = finalizeEvent(eventTemplate, privateKeyBytes);
  const eventJson = JSON.stringify(signedEvent);
  const base64Event = Buffer.from(eventJson, 'utf-8').toString('base64');

  return `Nostr ${base64Event}`;
}
