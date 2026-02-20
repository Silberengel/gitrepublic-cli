/**
 * Fetch user profile (kind 0) from Nostr relays
 */

import { SimplePool } from 'nostr-tools';
import { DEFAULT_NOSTR_RELAYS } from '../config.js';

/**
 * Fetch kind 0 profile event from relays
 */
export async function fetchProfileFromRelays(pubkey, relays = null) {
  try {
    const pool = new SimplePool();
    const relayList = relays || DEFAULT_NOSTR_RELAYS;
    
    // Ensure pubkey is in hex format (getPublicKey returns hex string)
    const pubkeyHex = typeof pubkey === 'string' && pubkey.length === 64 
      ? pubkey.toLowerCase() 
      : pubkey;
    
    const events = await pool.querySync(relayList, [
      {
        kinds: [0], // Kind 0 = profile metadata
        authors: [pubkeyHex],
        limit: 1
      }
    ]);
    
    pool.close(relayList);

    if (events.length === 0) {
      return null;
    }

    const event = events[0];
    const profile = {};

    // Try to parse JSON content
    try {
      const content = JSON.parse(event.content);
      profile.displayName = content.display_name || content.displayName;
      profile.name = content.name;
      profile.nip05 = content.nip05;
    } catch {
      // Invalid JSON, try tags
    }

    // Check tags for nip05 (newer format)
    if (!profile.nip05) {
      const nip05Tag = event.tags.find((tag) => 
        (tag[0] === 'nip05' || tag[0] === 'l') && tag[1]
      );
      if (nip05Tag && nip05Tag[1]) {
        profile.nip05 = nip05Tag[1];
      }
    }

    return profile;
  } catch (error) {
    console.warn('Failed to fetch profile from relays:', error);
    return null;
  }
}
