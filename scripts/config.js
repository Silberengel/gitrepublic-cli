/**
 * Configuration constants
 */

// NIP-98 auth event kind
export const KIND_NIP98_AUTH = 27235;

// Default server URL
export const DEFAULT_SERVER = process.env.GITREPUBLIC_SERVER || 'http://localhost:5173';

/**
 * Default Nostr relays to use for operations (publishing, fetching)
 * Can be overridden by NOSTR_RELAYS env var (comma-separated list)
 * 
 */
export const DEFAULT_NOSTR_RELAYS = 
  typeof process !== 'undefined' && process.env?.NOSTR_RELAYS
    ? process.env.NOSTR_RELAYS.split(',').map(r => r.trim()).filter(r => r.length > 0)
    : [
        'wss://theforest.nostr1.com',
        'wss://nostr.land',
      ];

/**
 * Nostr relays to use for searching for repositories, profiles, or other events
 * Can be overridden by NOSTR_SEARCH_RELAYS env var (comma-separated list)
 * 
 */
export const DEFAULT_NOSTR_SEARCH_RELAYS = 
  typeof process !== 'undefined' && process.env?.NOSTR_SEARCH_RELAYS
    ? process.env.NOSTR_SEARCH_RELAYS.split(',').map(r => r.trim()).filter(r => r.length > 0)
    : [
      'wss://theforest.nostr1.com',
      'wss://nostr.land',
      'wss://relay.damus.io',
      'wss://thecitadel.nostr1.com',
      'wss://nostr21.com',
      'wss://relay.primal.net',
      
      ];