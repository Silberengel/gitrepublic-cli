/**
 * Sanitize error messages to prevent private key leaks
 * @param {string} message - Error message to sanitize
 * @returns {string} - Sanitized error message
 */
export function sanitizeErrorMessage(message) {
  if (!message || typeof message !== 'string') {
    return String(message);
  }
  
  return message
    .replace(/nsec[0-9a-z]+/gi, '[nsec]')
    .replace(/[0-9a-f]{64}/gi, '[hex-key]')
    .replace(/private.*key[=:]\s*[^\s]+/gi, '[private-key]')
    .replace(/secret.*key[=:]\s*[^\s]+/gi, '[secret-key]')
    .replace(/NOSTRGIT_SECRET_KEY[=:]\s*[^\s]+/gi, 'NOSTRGIT_SECRET_KEY=[redacted]')
    .replace(/NOSTR_PRIVATE_KEY[=:]\s*[^\s]+/gi, 'NOSTR_PRIVATE_KEY=[redacted]')
    .replace(/NSEC[=:]\s*[^\s]+/gi, 'NSEC=[redacted]');
}
