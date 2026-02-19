/**
 * Configuration constants
 */

// NIP-98 auth event kind
export const KIND_NIP98_AUTH = 27235;

// Default server URL
export const DEFAULT_SERVER = process.env.GITREPUBLIC_SERVER || 'http://localhost:5173';

// Default relays
export const DEFAULT_RELAYS = [
  'wss://nostr.land',
  'wss://relay.damus.io',
  'wss://thecitadel.nostr1.com',
  'wss://nostr21.com',
  'wss://theforest.nostr1.com',
  'wss://freelay.sovbit.host',
  'wss://nostr.sovbit.host',
  'wss://bevos.nostr1.com',
  'wss://relay.primal.net',
];
