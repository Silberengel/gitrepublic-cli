import { SimplePool } from 'nostr-tools';
import { sanitizeErrorMessage } from '../utils/error-sanitizer.js';

/**
 * Publish event to Nostr relays using SimplePool
 * 
 * This function publishes to all relays in parallel. Each relay has its own
 * timeout (default 4400ms) to prevent hanging when relays fail.
 * 
 * @param {Object} event - Nostr event to publish
 * @param {string[]} relays - Array of relay URLs
 * @param {Uint8Array} privateKeyBytes - Private key bytes (required for auth if needed)
 * @param {string} pubkey - Public key (optional, for logging)
 * @returns {Promise<{success: string[], failed: Array<{relay: string, error: string}>}>}
 */
export async function publishToRelays(event, relays, privateKeyBytes, pubkey = null) {
  if (!privateKeyBytes) {
    throw new Error('Private key is required for publishing events');
  }

  if (!relays || relays.length === 0) {
    return { success: [], failed: [] };
  }

  const pool = new SimplePool();
  const success = [];
  const failed = [];

  try {
    // pool.publish returns an array of Promises, one for each relay
    // Each promise resolves to a string (reason) on success or rejects with an error on failure
    const publishPromises = pool.publish(relays, event);
    
    // Wait for all promises to settle (either resolve or reject)
    // Use allSettled to handle both successes and failures without throwing
    const results = await Promise.allSettled(publishPromises);
    
    // Process results - map back to relay URLs
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const relayUrl = relays[i];
      
      if (result.status === 'fulfilled') {
        // Promise resolved successfully - relay accepted the event
        // The resolved value is a string (reason from the relay's OK message)
        success.push(relayUrl);
      } else {
        // Promise rejected - relay failed or timed out
        const errorMessage = result.reason instanceof Error 
          ? result.reason.message 
          : String(result.reason);
        
        failed.push({ 
          relay: relayUrl, 
          error: sanitizeErrorMessage(errorMessage) 
        });
      }
    }
  } catch (error) {
    // Fallback error handling (shouldn't happen with allSettled, but just in case)
    const errorMessage = error instanceof Error ? error.message : String(error);
    const sanitizedError = sanitizeErrorMessage(errorMessage);
    
    for (const relayUrl of relays) {
      failed.push({ relay: relayUrl, error: sanitizedError });
    }
  } finally {
    // Close all connections in the pool
    try {
      await pool.close(relays);
    } catch (closeError) {
      // Ignore close errors - connections may already be closed
    }
  }

  return { success, failed };
}
