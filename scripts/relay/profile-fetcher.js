/**
 * Fetch user profile (kind 0) and payment targets (kind 10133) from Nostr relays
 */

import { SimplePool } from 'nostr-tools';
import { DEFAULT_NOSTR_RELAYS } from '../config.js';

/**
 * Fetch kind 0 profile event and kind 10133 payment targets from relays
 */
export async function fetchProfileFromRelays(pubkey, relays = null) {
  try {
    const pool = new SimplePool();
    const relayList = relays || DEFAULT_NOSTR_RELAYS;
    
    // Ensure pubkey is in hex format (getPublicKey returns hex string)
    const pubkeyHex = typeof pubkey === 'string' && pubkey.length === 64 
      ? pubkey.toLowerCase() 
      : pubkey;
    
    // Fetch kind 0 (profile) and kind 10133 (payment targets) in parallel
    const [profileEvents, paymentEvents] = await Promise.all([
      pool.querySync(relayList, [
        {
          kinds: [0], // Kind 0 = profile metadata
          authors: [pubkeyHex],
          limit: 1
        }
      ]),
      pool.querySync(relayList, [
        {
          kinds: [10133], // Kind 10133 = payment targets (NIP-A3)
          authors: [pubkeyHex],
          limit: 1
        }
      ])
    ]);
    
    pool.close(relayList);

    const profile = {};
    let profileEvent = null;
    let paymentTargets = [];

    // Process profile event (kind 0)
    if (profileEvents.length > 0) {
      profileEvent = profileEvents[0];
      
      // Try to parse JSON content (old format)
      let profileData = {};
      try {
        profileData = JSON.parse(profileEvent.content);
      } catch {
        // Invalid JSON, will use tags
      }
      
      // Extract from tags (new format) - prefer tags over JSON
      const nameTag = profileEvent.tags.find(t => t[0] === 'name' || t[0] === 'display_name')?.[1];
      const aboutTag = profileEvent.tags.find(t => t[0] === 'about')?.[1];
      const pictureTag = profileEvent.tags.find(t => t[0] === 'picture' || t[0] === 'avatar')?.[1];
      
      profile.displayName = nameTag || profileData.display_name || profileData.name;
      profile.name = profileData.name;
      profile.about = aboutTag || profileData.about;
      profile.picture = pictureTag || profileData.picture;
      
      // Check tags for nip05 (newer format)
      const nip05Tag = profileEvent.tags.find((tag) => 
        (tag[0] === 'nip05' || tag[0] === 'l') && tag[1]
      );
      if (nip05Tag && nip05Tag[1]) {
        profile.nip05 = nip05Tag[1];
      } else if (profileData.nip05) {
        profile.nip05 = profileData.nip05;
      }
    }

    // Initialize lightning addresses set for collecting from multiple sources
    const lightningAddresses = new Set<string>();
    
    // Extract lightning addresses from NIP-01 (lud16 tag or JSON)
    if (profileEvent) {
      // From tags (lud16)
      const lud16Tags = profileEvent.tags.filter(t => t[0] === 'lud16').map(t => t[1]).filter(Boolean);
      lud16Tags.forEach(addr => lightningAddresses.add(addr.toLowerCase()));
      
      // From JSON (lud16 field)
      try {
        const profileData = JSON.parse(profileEvent.content);
        if (profileData.lud16 && typeof profileData.lud16 === 'string') {
          lightningAddresses.add(profileData.lud16.toLowerCase());
        }
      } catch {
        // Invalid JSON, ignore
      }
    }
    
    // Extract lightning addresses from kind 10133
    if (paymentEvents.length > 0) {
      const paytoTags = paymentEvents[0].tags.filter(t => t[0] === 'payto' && t[1] === 'lightning' && t[2]);
      paytoTags.forEach(tag => {
        if (tag[2]) {
          lightningAddresses.add(tag[2].toLowerCase());
        }
      });
    }
    
    // Build payment targets array - start with lightning addresses
    paymentTargets = Array.from(lightningAddresses).map(authority => ({
      type: 'lightning',
      authority,
      payto: `payto://lightning/${authority}`
    }));
    
    // Also include other payment types from kind 10133
    if (paymentEvents.length > 0) {
      const otherPaytoTags = paymentEvents[0].tags.filter(t => t[0] === 'payto' && t[1] && t[1] !== 'lightning' && t[2]);
      otherPaytoTags.forEach(tag => {
        const type = tag[1]?.toLowerCase() || '';
        const authority = tag[2] || '';
        if (type && authority) {
          // Check if we already have this (for deduplication)
          const existing = paymentTargets.find(p => p.type === type && p.authority.toLowerCase() === authority.toLowerCase());
          if (!existing) {
            paymentTargets.push({
              type,
              authority,
              payto: `payto://${type}/${authority}`
            });
          }
        }
      });
    }
    
    return {
      ...profile,
      paymentTargets
    };
  } catch (error) {
    console.warn('Failed to fetch profile from relays:', error);
    return null;
  }
}
