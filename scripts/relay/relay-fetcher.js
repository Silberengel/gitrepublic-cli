import { SimplePool } from 'nostr-tools';
import { DEFAULT_NOSTR_RELAYS } from '../config.js';

/**
 * Normalize a relay URL (similar to nostr-tools normalizeURL but simpler)
 */
function normalizeRelayUrl(url) {
  if (!url) return null;
  
  try {
    // Remove trailing slashes
    url = url.trim().replace(/\/+$/, '');
    
    // Add protocol if missing
    if (!url.includes('://')) {
      url = 'wss://' + url;
    }
    
    // Parse and normalize
    const urlObj = new URL(url);
    
    // Normalize protocol
    if (urlObj.protocol === 'http:') {
      urlObj.protocol = 'ws:';
    } else if (urlObj.protocol === 'https:') {
      urlObj.protocol = 'wss:';
    }
    
    // Normalize pathname
    urlObj.pathname = urlObj.pathname.replace(/\/+/g, '/');
    if (urlObj.pathname.endsWith('/')) {
      urlObj.pathname = urlObj.pathname.slice(0, -1);
    }
    
    // Remove default ports
    if (urlObj.port === '80' && urlObj.protocol === 'ws:') {
      urlObj.port = '';
    } else if (urlObj.port === '443' && urlObj.protocol === 'wss:') {
      urlObj.port = '';
    }
    
    // Remove hash and sort search params
    urlObj.hash = '';
    urlObj.searchParams.sort();
    
    return urlObj.toString();
  } catch (e) {
    // Invalid URL, return null
    return null;
  }
}

/**
 * Extract relay URLs from an event's "r" tags
 */
function extractRelayUrls(event) {
  if (!event || !event.tags) return [];
  
  const relayUrls = [];
  for (const tag of event.tags) {
    if (tag[0] === 'r' && tag[1]) {
      const normalized = normalizeRelayUrl(tag[1]);
      if (normalized) {
        relayUrls.push(normalized);
      }
    }
  }
  
  return relayUrls;
}

/**
 * Fetch relay lists from a pubkey
 * Returns: { outboxes: string[], localRelays: string[], blockedRelays: string[] }
 */
export async function fetchRelayLists(pubkey, queryRelays = null) {
  const pool = new SimplePool();
  const relays = queryRelays || DEFAULT_NOSTR_RELAYS;
  
  const outboxes = [];
  const localRelays = [];
  const blockedRelays = [];
  
  try {
    // Fetch kind 10002 (inboxes/outboxes)
    try {
      const outboxEvents = await pool.querySync(relays, [
        {
          kinds: [10002],
          authors: [pubkey],
          limit: 1
        }
      ]);
      
      if (outboxEvents.length > 0) {
        // Get the most recent event
        const latestEvent = outboxEvents.sort((a, b) => b.created_at - a.created_at)[0];
        const urls = extractRelayUrls(latestEvent);
        outboxes.push(...urls);
      }
    } catch (error) {
      // Silently fail - relay lists are optional
    }
    
    // Fetch kind 10432 (local relays)
    try {
      const localRelayEvents = await pool.querySync(relays, [
        {
          kinds: [10432],
          authors: [pubkey],
          limit: 1
        }
      ]);
      
      if (localRelayEvents.length > 0) {
        // Get the most recent event
        const latestEvent = localRelayEvents.sort((a, b) => b.created_at - a.created_at)[0];
        const urls = extractRelayUrls(latestEvent);
        localRelays.push(...urls);
      }
    } catch (error) {
      // Silently fail - relay lists are optional
    }
    
    // Fetch kind 10006 (blocked relays)
    try {
      const blockedRelayEvents = await pool.querySync(relays, [
        {
          kinds: [10006],
          authors: [pubkey],
          limit: 1
        }
      ]);
      
      if (blockedRelayEvents.length > 0) {
        // Get the most recent event
        const latestEvent = blockedRelayEvents.sort((a, b) => b.created_at - a.created_at)[0];
        const urls = extractRelayUrls(latestEvent);
        blockedRelays.push(...urls);
      }
    } catch (error) {
      // Silently fail - relay lists are optional
    }
  } finally {
    // Close pool connections
    try {
      await pool.close(relays);
    } catch (closeError) {
      // Ignore close errors
    }
  }
  
  return { outboxes, localRelays, blockedRelays };
}

/**
 * Enhance relay list with user's relay preferences
 * - Adds outboxes (write relays) and local relays
 * - Removes blocked relays
 * - Normalizes and deduplicates
 */
export async function enhanceRelayList(baseRelays, pubkey, queryRelays = null) {
  // Normalize base relays
  const normalizedBase = baseRelays
    .map(url => normalizeRelayUrl(url))
    .filter(url => url !== null);
  
  // Fetch user's relay lists
  const { outboxes, localRelays, blockedRelays } = await fetchRelayLists(pubkey, queryRelays || normalizedBase);
  
  // Normalize blocked relays
  const normalizedBlocked = new Set(
    blockedRelays.map(url => normalizeRelayUrl(url)).filter(url => url !== null)
  );
  
  // Combine base relays, outboxes, and local relays
  const allRelays = [
    ...normalizedBase,
    ...outboxes.map(url => normalizeRelayUrl(url)).filter(url => url !== null),
    ...localRelays.map(url => normalizeRelayUrl(url)).filter(url => url !== null)
  ];
  
  // Deduplicate and remove blocked relays
  const seen = new Set();
  const enhanced = [];
  
  for (const relay of allRelays) {
    if (relay && !seen.has(relay) && !normalizedBlocked.has(relay)) {
      seen.add(relay);
      enhanced.push(relay);
    }
  }
  
  return enhanced;
}
