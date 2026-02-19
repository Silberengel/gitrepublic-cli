#!/usr/bin/env node
/**
 * GitRepublic CLI - API command handler
 * 
 * This script handles API commands (push-all, repos, publish, etc.) when called
 * from git-wrapper.js. It can also be called directly via gitrep-api/gitrepublic-api
 * for backward compatibility.
 * 
 * Usage (via gitrep/gitrepublic):
 *   gitrep push-all [branch] [options]
 *   gitrep repos list
 *   gitrep publish <subcommand>
 * 
 * Usage (direct, for backward compatibility):
 *   gitrep-api push-all [branch] [options]
 *   gitrepublic-api repos list
 * 
 * Commands:
 *   push-all [branch] [--force] [--tags] [--dry-run]  Push to all remotes
 *   repos list                    List repositories
 *   repos get <npub> <repo>       Get repository info
 *   repos settings <npub> <repo>  Get/update repository settings
 *   repos maintainers <npub> <repo> [add|remove] <npub>  Manage maintainers
 *   repos branches <npub> <repo>  List branches
 *   repos tags <npub> <repo>      List tags
 *   repos fork <npub> <repo>      Fork a repository
 *   repos delete <npub> <repo>    Delete a repository
 *   file get <npub> <repo> <path> Get file content
 *   file put <npub> <repo> <path> Create/update file
 *   file delete <npub> <repo> <path> Delete file
 *   search <query>                Search repositories
 *   publish <subcommand>          Publish Nostr events
 *   verify <event-file>           Verify Nostr event signatures
 *   config [server]               Show configuration
 * 
 * Options:
 *   --server <url>                GitRepublic server URL (default: http://localhost:5173)
 *   --key <nsec>                  Nostr private key (overrides NOSTRGIT_SECRET_KEY)
 *   --json                        Output JSON format
 *   --help                        Show help
 */

import { createHash } from 'crypto';
import { finalizeEvent, getPublicKey, nip19, SimplePool, verifyEvent, getEventHash, Relay } from 'nostr-tools';
import { decode } from 'nostr-tools/nip19';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname, resolve } from 'path';

/**
 * Sanitize error messages to prevent private key leaks
 * @param {string} message - Error message to sanitize
 * @returns {string} - Sanitized error message
 */
function sanitizeErrorMessage(message) {
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

// Handle unhandled promise rejections from SimplePool to prevent crashes
// SimplePool can reject promises asynchronously from WebSocket handlers
// NEVER log private keys or sensitive data
process.on('unhandledRejection', (reason, promise) => {
  // Silently handle relay errors - they're already logged in publishToRelays
  // Only log if it's not a known relay error pattern
  const errorMessage = reason instanceof Error ? reason.message : String(reason);
  const sanitized = sanitizeErrorMessage(errorMessage);
  
  if (!sanitized.includes('restricted') && !sanitized.includes('Relay did not accept')) {
    // Unknown error, but don't crash - just log it (sanitized)
    console.error('Warning: Unhandled promise rejection:', sanitized);
  }
  // Don't exit - let the normal error handling continue
});

// NIP-98 auth event kind
const KIND_NIP98_AUTH = 27235;

// Default server URL
// Note: localhost:5173 is the SvelteKit dev server port
// In production, set GITREPUBLIC_SERVER environment variable to your server URL
const DEFAULT_SERVER = process.env.GITREPUBLIC_SERVER || 'http://localhost:5173';

/**
 * Decode Nostr key and get private key bytes
 */
/**
 * Get private key bytes from nsec or hex string
 * NEVER logs or exposes the private key
 * @param {string} key - nsec string or hex private key
 * @returns {Uint8Array} - Private key bytes
 */
function getPrivateKeyBytes(key) {
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
 * Create NIP-98 authentication header
 */
function createNIP98Auth(url, method, body = null) {
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

/**
 * Store event in appropriate JSONL file based on event kind
 */
function storeEventInJsonl(event) {
  try {
    // Find repository root (look for .git directory)
    let repoRoot = null;
    let currentDir = process.cwd();
    
    for (let i = 0; i < 10; i++) {
      const potentialGitDir = join(currentDir, '.git');
      if (existsSync(potentialGitDir)) {
        repoRoot = currentDir;
        break;
      }
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
    
    if (!repoRoot) {
      // Not in a git repo, skip storing
      return;
    }
    
    // Create nostr/ directory if it doesn't exist
    const nostrDir = join(repoRoot, 'nostr');
    if (!existsSync(nostrDir)) {
      execSync(`mkdir -p "${nostrDir}"`, { stdio: 'ignore' });
    }
    
    // Determine JSONL file name based on event kind
    let jsonlFile;
    switch (event.kind) {
      case 30617: // REPO_ANNOUNCEMENT
        jsonlFile = join(nostrDir, 'repo-announcements.jsonl');
        break;
      case 1641: // OWNERSHIP_TRANSFER
        jsonlFile = join(nostrDir, 'ownership-transfers.jsonl');
        break;
      case 1617: // PATCH
        jsonlFile = join(nostrDir, 'patches.jsonl');
        break;
      case 1618: // PULL_REQUEST
        jsonlFile = join(nostrDir, 'pull-requests.jsonl');
        break;
      case 1619: // PULL_REQUEST_UPDATE
        jsonlFile = join(nostrDir, 'pull-request-updates.jsonl');
        break;
      case 1621: // ISSUE
        jsonlFile = join(nostrDir, 'issues.jsonl');
        break;
      case 1630: // STATUS_OPEN
      case 1631: // STATUS_APPLIED
      case 1632: // STATUS_CLOSED
      case 1633: // STATUS_DRAFT
        jsonlFile = join(nostrDir, 'status-events.jsonl');
        break;
      case 30618: // REPO_STATE
        jsonlFile = join(nostrDir, 'repo-states.jsonl');
        break;
      default:
        // Store unknown event types in a generic file
        jsonlFile = join(nostrDir, `events-kind-${event.kind}.jsonl`);
    }
    
    // Append event to JSONL file
    const eventLine = JSON.stringify(event) + '\n';
    writeFileSync(jsonlFile, eventLine, { flag: 'a', encoding: 'utf-8' });
  } catch (error) {
    // Silently fail - storing is optional
  }
}

/**
 * Publish event to Nostr relays using SimplePool
 * 
 * This refactored version uses SimplePool (the recommended approach from nostr-tools)
 * instead of managing individual Relay instances. SimplePool handles:
 * - Connection establishment and management automatically
 * - Automatic reconnection on failures
 * - Timeout handling
 * - Connection pooling for efficiency
 * 
 * Auth is handled on-demand only when a relay requires it (not proactively),
 * which matches the behavior before auth was added and avoids connection issues.
 * 
 * We publish to each relay individually to get per-relay results and error details.
 */
async function publishToRelays(event, relays, privateKeyBytes, pubkey = null) {
  if (!privateKeyBytes) {
    throw new Error('Private key is required for publishing events');
  }

  if (!relays || relays.length === 0) {
    return { success: [], failed: [] };
  }

  const pool = new SimplePool();
  const success = [];
  const failed = [];

  // Publish to each relay individually with individual timeouts
  // This prevents hanging when all relays fail - each relay gets its own timeout
  const publishPromises = relays.map(async (relayUrl) => {
    try {
      // Publish to a single relay with timeout
      const publishPromise = pool.publish([relayUrl], event);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Publish timeout after 8 seconds')), 8000)
      );
      
      const successfulRelays = await Promise.race([publishPromise, timeoutPromise]);
      
      // Check if this relay succeeded
      if (successfulRelays && typeof successfulRelays.has === 'function') {
        if (successfulRelays.has(relayUrl)) {
          return { relay: relayUrl, success: true };
        }
      } else if (Array.isArray(successfulRelays) && successfulRelays.includes(relayUrl)) {
        return { relay: relayUrl, success: true };
      }
      
      // Relay didn't succeed
      return { relay: relayUrl, success: false, error: 'Failed to publish to relay' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const sanitizedError = sanitizeErrorMessage(errorMessage);
      
      if (errorMessage.includes('timeout')) {
        return { relay: relayUrl, success: false, error: 'Publish timeout - relay did not respond' };
      } else {
        return { relay: relayUrl, success: false, error: sanitizedError };
      }
    }
  });

  // Wait for all publish attempts to complete (with their individual timeouts)
  const results = await Promise.allSettled(publishPromises);
  
  // Process results
  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (result.value.success) {
        success.push(result.value.relay);
      } else {
        failed.push({ relay: result.value.relay, error: result.value.error });
      }
    } else {
      failed.push({ relay: 'unknown', error: result.reason?.message || 'Unknown error' });
    }
  }

  // Close all connections in the pool
  try {
    await pool.close(relays);
  } catch (closeError) {
    // Ignore close errors
  }

  return { success, failed };
}

/**
 * Add client tag to event tags unless --no-client-tag is specified
 * @param {Array} tags - Array of tag arrays
 * @param {Array} args - Command arguments array
 */
function addClientTag(tags, args) {
  const noClientTag = args && args.includes('--no-client-tag');
  if (!noClientTag) {
    tags.push(['client', 'gitrepublic-cli']);
  }
  return tags;
}

/**
 * Make authenticated API request
 */
async function apiRequest(server, endpoint, method = 'GET', body = null, options = {}) {
  const url = `${server.replace(/\/$/, '')}/api${endpoint}`;
  const authHeader = createNIP98Auth(url, method, body);

  const headers = {
    'Authorization': authHeader,
    'Content-Type': 'application/json'
  };

  const fetchOptions = {
    method,
    headers,
    ...options
  };

  if (body && method !== 'GET') {
    fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const response = await fetch(url, fetchOptions);
  const text = await response.text();
  
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    // Sanitize error message to prevent key leaks
    const errorData = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
    const sanitizedData = sanitizeErrorMessage(errorData);
    throw new Error(`API request failed: ${response.status} ${response.statusText}\n${sanitizedData}`);
  }

  return data;
}

/**
 * Command handlers
 */
const commands = {
  async repos(args, server, json) {
    const subcommand = args[0];
    
    if (subcommand === 'list') {
      // Get registered and unregistered repos from Nostr
      const listData = await apiRequest(server, '/repos/list', 'GET');
      
      // Get local repos (cloned on server)
      let localRepos = [];
      try {
        localRepos = await apiRequest(server, '/repos/local', 'GET');
      } catch (err) {
        // Local repos endpoint might not be available or might fail
        // Continue without local repos
      }
      
      // Helper function to check verification status
      async function checkVerification(npub, repoName) {
        try {
          // The verify endpoint doesn't require authentication, so we can call it directly
          const url = `${server.replace(/\/$/, '')}/api/repos/${npub}/${repoName}/verify`;
          const response = await fetch(url);
          if (!response.ok) {
            // If endpoint returns error, assume not verified
            return false;
          }
          const verifyData = await response.json();
          // Return true only if verified is explicitly true
          return verifyData.verified === true;
        } catch (err) {
          // Silently fail - assume not verified if check fails
          return false;
        }
      }
      
      // Check verification status for all repos (in parallel for performance)
      const registered = listData.registered || [];
      const verificationPromises = [];
      
      // Check verification for registered repos
      for (const repo of registered) {
        const name = repo.repoName || repo.name || 'unknown';
        const npub = repo.npub || 'unknown';
        if (name !== 'unknown' && npub !== 'unknown') {
          verificationPromises.push(
            checkVerification(npub, name).then(verified => ({ 
              key: `${npub}/${name}`, 
              verified 
            }))
          );
        }
      }
      
      // Check verification for local repos
      for (const repo of localRepos) {
        const name = repo.repoName || repo.name || 'unknown';
        const npub = repo.npub || 'unknown';
        if (name !== 'unknown' && npub !== 'unknown') {
          verificationPromises.push(
            checkVerification(npub, name).then(verified => ({ 
              key: `${npub}/${name}`, 
              verified 
            }))
          );
        }
      }
      
      // Wait for all verification checks to complete
      const verificationResults = await Promise.all(verificationPromises);
      const verifiedMap = new Map();
      verificationResults.forEach(result => {
        verifiedMap.set(result.key, result.verified);
      });
      
      // Debug: Log verification results if needed
      // console.error('Verification map:', Array.from(verifiedMap.entries()));
      
      if (json) {
        // Add verification status to JSON output
        const registeredWithVerification = registered.map(repo => ({
          ...repo,
          verified: verifiedMap.get(`${repo.npub}/${repo.repoName || repo.name || 'unknown'}`) || false
        }));
        const localWithVerification = localRepos.map(repo => ({
          ...repo,
          verified: verifiedMap.get(`${repo.npub}/${repo.repoName || repo.name || 'unknown'}`) || false
        }));
        
        console.log(JSON.stringify({
          registered: registeredWithVerification,
          local: localWithVerification,
          total: {
            registered: registered.length,
            local: localRepos.length,
            total: (registered.length + localRepos.length)
          }
        }, null, 2));
      } else {
        // Display help text explaining the difference
        console.log('Repository Types:');
        console.log('  Registered: Repositories announced on Nostr with this server in their clone URLs');
        console.log('  Local: Repositories cloned on this server (may be registered or unregistered)');
        console.log('  Verified: Repository ownership has been cryptographically verified');
        console.log('');
        
        // Display registered repositories
        if (registered.length > 0) {
          console.log('Registered Repositories:');
          registered.forEach(repo => {
            const name = repo.repoName || repo.name || 'unknown';
            const npub = repo.npub || 'unknown';
            const desc = repo.event?.tags?.find(t => t[0] === 'description')?.[1] || 
                        repo.description || 
                        'No description';
            const key = `${npub}/${name}`;
            const verified = verifiedMap.has(key) ? verifiedMap.get(key) : false;
            const verifiedStatus = verified ? 'verified' : 'unverified';
            console.log(`  ${npub}/${name} (${verifiedStatus}) - ${desc}`);
          });
          console.log('');
        }
        
        // Display local repositories
        if (localRepos.length > 0) {
          console.log('Local Repositories:');
          localRepos.forEach(repo => {
            const name = repo.repoName || repo.name || 'unknown';
            const npub = repo.npub || 'unknown';
            const desc = repo.announcement?.tags?.find(t => t[0] === 'description')?.[1] || 
                        repo.description || 
                        'No description';
            const registrationStatus = repo.isRegistered ? 'registered' : 'unregistered';
            const key = `${npub}/${name}`;
            // Get verification status - use has() to distinguish between false and undefined
            const verified = verifiedMap.has(key) ? verifiedMap.get(key) : false;
            const verifiedStatus = verified ? 'verified' : 'unverified';
            console.log(`  ${npub}/${name} (${registrationStatus}, ${verifiedStatus}) - ${desc}`);
          });
          console.log('');
        }
        
        // Summary
        const totalRegistered = registered.length;
        const totalLocal = localRepos.length;
        const totalVerified = Array.from(verifiedMap.values()).filter(v => v === true).length;
        if (totalRegistered === 0 && totalLocal === 0) {
          console.log('No repositories found.');
        } else {
          console.log(`Total: ${totalRegistered} registered, ${totalLocal} local, ${totalVerified} verified`);
        }
      }
    } else if (subcommand === 'get' && args[1]) {
      let npub, repo;
      
      // Check if first argument is naddr format
      if (args[1].startsWith('naddr1')) {
        try {
          const decoded = decode(args[1]);
          if (decoded.type === 'naddr') {
            const data = decoded.data;
            // naddr contains pubkey (hex) and identifier (d-tag)
            npub = nip19.npubEncode(data.pubkey);
            repo = data.identifier || data['d'];
            if (!repo) {
              throw new Error('Invalid naddr: missing identifier (d-tag)');
            }
          } else {
            throw new Error('Invalid naddr format');
          }
        } catch (err) {
          console.error(`Error: Failed to decode naddr: ${err.message}`);
          process.exit(1);
        }
      } else if (args[2]) {
        // Traditional npub/repo format
        [npub, repo] = args.slice(1);
      } else {
        console.error('Error: Invalid arguments. Use: repos get <npub> <repo> or repos get <naddr>');
        process.exit(1);
      }
      
      const data = await apiRequest(server, `/repos/${npub}/${repo}/settings`, 'GET');
      if (json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`Repository: ${npub}/${repo}`);
        console.log(`Description: ${data.description || 'No description'}`);
        console.log(`Private: ${data.private ? 'Yes' : 'No'}`);
        console.log(`Owner: ${data.owner || npub}`);
      }
    } else if (subcommand === 'settings' && args[1] && args[2]) {
      const [npub, repo] = args.slice(1);
      if (args[3]) {
        // Update settings
        const settings = {};
        for (let i = 3; i < args.length; i += 2) {
          const key = args[i].replace('--', '');
          const value = args[i + 1];
          if (key === 'description') settings.description = value;
          else if (key === 'private') settings.private = value === 'true';
        }
        const data = await apiRequest(server, `/repos/${npub}/${repo}/settings`, 'POST', settings);
        console.log(json ? JSON.stringify(data, null, 2) : 'Settings updated successfully');
      } else {
        // Get settings
        const data = await apiRequest(server, `/repos/${npub}/${repo}/settings`, 'GET');
        console.log(json ? JSON.stringify(data, null, 2) : JSON.stringify(data, null, 2));
      }
    } else if (subcommand === 'maintainers' && args[1] && args[2]) {
      const [npub, repo] = args.slice(1);
      const action = args[3];
      const maintainerNpub = args[4];
      
      if (action === 'add' && maintainerNpub) {
        const data = await apiRequest(server, `/repos/${npub}/${repo}/maintainers`, 'POST', { maintainer: maintainerNpub });
        console.log(json ? JSON.stringify(data, null, 2) : `Maintainer ${maintainerNpub} added successfully`);
      } else if (action === 'remove' && maintainerNpub) {
        const data = await apiRequest(server, `/repos/${npub}/${repo}/maintainers`, 'DELETE', { maintainer: maintainerNpub });
        console.log(json ? JSON.stringify(data, null, 2) : `Maintainer ${maintainerNpub} removed successfully`);
      } else {
        // List maintainers
        const data = await apiRequest(server, `/repos/${npub}/${repo}/maintainers`, 'GET');
        if (json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(`Repository: ${npub}/${repo}`);
          console.log(`Owner: ${data.owner}`);
          console.log(`Maintainers: ${data.maintainers?.length || 0}`);
          if (data.maintainers?.length > 0) {
            data.maintainers.forEach(m => console.log(`  - ${m}`));
          }
        }
      }
    } else if (subcommand === 'branches' && args[1] && args[2]) {
      const [npub, repo] = args.slice(1);
      const data = await apiRequest(server, `/repos/${npub}/${repo}/branches`, 'GET');
      if (json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`Branches for ${npub}/${repo}:`);
        if (Array.isArray(data)) {
          data.forEach(branch => {
            console.log(`  ${branch.name} - ${branch.commit?.substring(0, 7) || 'N/A'}`);
          });
        }
      }
    } else if (subcommand === 'tags' && args[1] && args[2]) {
      const [npub, repo] = args.slice(1);
      const data = await apiRequest(server, `/repos/${npub}/${repo}/tags`, 'GET');
      if (json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`Tags for ${npub}/${repo}:`);
        if (Array.isArray(data)) {
          data.forEach(tag => {
            console.log(`  ${tag.name} - ${tag.hash?.substring(0, 7) || 'N/A'}`);
          });
        }
      }
    } else if (subcommand === 'fork' && args[1] && args[2]) {
      const [npub, repo] = args.slice(1);
      const data = await apiRequest(server, `/repos/${npub}/${repo}/fork`, 'POST', {});
      if (json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`Repository forked successfully: ${data.npub}/${data.repo}`);
      }
    } else if (subcommand === 'delete' && args[1] && args[2]) {
      const [npub, repo] = args.slice(1);
      const data = await apiRequest(server, `/repos/${npub}/${repo}/delete`, 'DELETE');
      console.log(json ? JSON.stringify(data, null, 2) : 'Repository deleted successfully');
    } else {
      console.error('Invalid repos command. Use: list, get, settings, maintainers, branches, tags, fork, delete');
      process.exit(1);
    }
  },

  async file(args, server, json) {
    const subcommand = args[0];
    
    if (subcommand === 'get' && args[1] && args[2] && args[3]) {
      const [npub, repo, path] = args.slice(1);
      const branch = args[4] || 'main';
      const data = await apiRequest(server, `/repos/${npub}/${repo}/file?path=${encodeURIComponent(path)}&branch=${branch}`, 'GET');
      if (json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(data.content || data);
      }
    } else if (subcommand === 'put' && args[1] && args[2] && args[3]) {
      const [npub, repo, path] = args.slice(1);
      let content;
      if (args[4]) {
        // Read from file
        try {
          content = readFileSync(args[4], 'utf-8');
        } catch (error) {
          throw new Error(`Failed to read file ${args[4]}: ${error.message}`);
        }
      } else {
        // Read from stdin
        const chunks = [];
        process.stdin.setEncoding('utf8');
        return new Promise((resolve, reject) => {
          process.stdin.on('readable', () => {
            let chunk;
            while ((chunk = process.stdin.read()) !== null) {
              chunks.push(chunk);
            }
          });
          process.stdin.on('end', async () => {
            content = chunks.join('');
            const commitMessage = args[5] || 'Update file';
            const branch = args[6] || 'main';
            
            try {
              const data = await apiRequest(server, `/repos/${npub}/${repo}/file`, 'POST', {
                path,
                content,
                commitMessage,
                branch,
                action: 'write'
              });
              console.log(json ? JSON.stringify(data, null, 2) : 'File updated successfully');
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        });
      }
      const commitMessage = args[5] || 'Update file';
      const branch = args[6] || 'main';
      
      const data = await apiRequest(server, `/repos/${npub}/${repo}/file`, 'POST', {
        path,
        content,
        commitMessage,
        branch,
        action: 'write'
      });
      console.log(json ? JSON.stringify(data, null, 2) : 'File updated successfully');
    } else if (subcommand === 'delete' && args[1] && args[2] && args[3]) {
      const [npub, repo, path] = args.slice(1);
      const commitMessage = args[4] || `Delete ${path}`;
      const branch = args[5] || 'main';
      
      const data = await apiRequest(server, `/repos/${npub}/${repo}/file`, 'POST', {
        path,
        commitMessage,
        branch,
        action: 'delete'
      });
      console.log(json ? JSON.stringify(data, null, 2) : 'File deleted successfully');
    } else {
      console.error('Invalid file command. Use: get <npub> <repo> <path> [branch], put <npub> <repo> <path> [file] [message] [branch], delete <npub> <repo> <path> [message] [branch]');
      process.exit(1);
    }
  },

  async search(args, server, json) {
    const query = args.join(' ');
    if (!query) {
      console.error('Search query required');
      process.exit(1);
    }
    const data = await apiRequest(server, `/search?q=${encodeURIComponent(query)}`, 'GET');
    if (json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`Search results for "${query}":`);
      if (Array.isArray(data)) {
        data.forEach(repo => {
          console.log(`  ${repo.npub}/${repo.name} - ${repo.description || 'No description'}`);
        });
      }
    }
  },

  async publish(args, server, json) {
    const subcommand = args[0];
    
    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
      console.log(`
Publish Nostr Git Events

Usage: gitrep publish <subcommand> [options]

Subcommands:
  repo-announcement <repo-name> [options]
    Publish a repository announcement (kind 30617)
    Options:
      --description <text>        Repository description
      --clone-url <url>          Clone URL (can be specified multiple times)
      --web-url <url>            Web URL (can be specified multiple times)
      --maintainer <npub>        Maintainer pubkey (can be specified multiple times)
      --relay <url>              Custom relay URL (can be specified multiple times)
    
    Example:
      gitrep publish repo-announcement myrepo \\
        --description "My awesome repo" \\
        --clone-url "https://gitrepublic.com/api/git/npub1.../myrepo.git" \\
        --maintainer "npub1..."

  ownership-transfer <repo> <new-owner-npub> [--self-transfer]
    Transfer repository ownership (kind 1641)
    Note: You must be the current owner (signing with NOSTRGIT_SECRET_KEY)
    
    Example:
      gitrep publish ownership-transfer myrepo npub1... --self-transfer

  pr <owner-npub> <repo> <title> [options]
    Create a pull request (kind 1618)
    Options:
      --content <text>           PR description/content
      --base <branch>           Base branch (default: main)
      --head <branch>           Head branch (default: main)
    
    Example:
      gitrep publish pr npub1... myrepo "Fix bug" \\
        --content "This PR fixes a critical bug" \\
        --base main --head feature-branch

  issue <owner-npub> <repo> <title> [options]
    Create an issue (kind 1621)
    Options:
      --content <text>           Issue description
      --label <label>            Label (can be specified multiple times)
    
    Example:
      gitrep publish issue npub1... myrepo "Bug report" \\
        --content "Found a bug" --label bug --label critical

  status <event-id> <open|applied|closed|draft> [--content <text>]
    Update PR/issue status (kinds 1630-1633)
    
    Example:
      gitrep publish status abc123... closed --content "Fixed in v1.0"

  patch <owner-npub> <repo> <patch-file> [options]
    Publish a git patch (kind 1617)
    Options:
      --earliest-commit <id>    Earliest unique commit ID (euc)
      --commit <id>             Current commit ID
      --parent-commit <id>      Parent commit ID
      --root                    Mark as root patch
      --root-revision           Mark as root revision
      --reply-to <event-id>     Reply to previous patch (NIP-10)
      --mention <npub>         Mention user (can be specified multiple times)
    
    Example:
      gitrep publish patch npub1... myrepo patch-0001.patch \\
        --earliest-commit abc123 --commit def456 --root

  repo-state <repo> [options]
    Publish repository state (kind 30618)
    Options:
      --ref <ref-path> <commit-id> [parent-commits...]  Add ref (can be specified multiple times)
      --head <branch>                                   Set HEAD branch
    
    Example:
      gitrep publish repo-state myrepo \\
        --ref refs/heads/main abc123 def456 \\
        --ref refs/tags/v1.0.0 xyz789 \\
        --head main

  pr-update <owner-npub> <repo> <pr-event-id> <commit-id> [options]

  event [options]
    Publish a generic Nostr event (defaults to kind 1)
    Options:
      --kind <number>              Event kind (default: 1)
      --content <text>             Event content (default: '')
      --tag <name> <value>         Add a tag (can be specified multiple times)
      --no-client-tag              Don't add client tag (default: adds 'client' tag)
      --relay <url>                Custom relay URL (can be specified multiple times)
    
    Examples:
      gitrep publish event --kind 1 --content "Hello, Nostr!"
      gitrep publish event --kind 1 --content "Hello" --tag "p" "npub1..."
      gitrep publish event --kind 42 --content "" --tag "t" "hashtag" --tag "p" "npub1..."
      gitrep publish event --kind 1 --content "Test" --no-client-tag
    Update pull request tip commit (kind 1619)
    Options:
      --pr-author <npub>       PR author pubkey (for NIP-22 tags)
      --clone-url <url>        Clone URL (required, can be specified multiple times)
      --merge-base <commit-id>  Most recent common ancestor
      --earliest-commit <id>   Earliest unique commit ID
      --mention <npub>         Mention user (can be specified multiple times)
    
    Example:
      gitrep publish pr-update npub1... myrepo pr-event-id new-commit-id \\
        --pr-author npub1... \\
        --clone-url "https://gitrepublic.com/api/git/npub1.../myrepo.git" \\
        --merge-base base-commit-id

Event Structure:
  All events are automatically signed with NOSTRGIT_SECRET_KEY and published to relays.
  Events are stored locally in nostr/ directory (JSONL format) for reference.
  
  For detailed event structure documentation, see:
  - https://github.com/silberengel/gitrepublic-web/tree/main/docs
  - docs/NIP_COMPLIANCE.md - NIP compliance and event kinds
  - docs/CustomKinds.md - Custom event kinds (1640, 1641, 30620)

Environment Variables:
  NOSTRGIT_SECRET_KEY           Required: Nostr private key (nsec or hex)
  NOSTR_RELAYS                  Optional: Comma-separated relay URLs (default: wss://theforest.nostr1.com,wss://relay.damus.io,wss://nostr.land)

For more information, see: https://github.com/silberengel/gitrepublic-cli
`);
      process.exit(0);
    }

    // Get private key
    const secretKey = process.env.NOSTRGIT_SECRET_KEY || process.env.NOSTR_PRIVATE_KEY || process.env.NSEC;
    if (!secretKey) {
      throw new Error('NOSTRGIT_SECRET_KEY environment variable is not set');
    }

    const privateKeyBytes = getPrivateKeyBytes(secretKey);
    const pubkey = getPublicKey(privateKeyBytes);

    // Get relays from environment or use defaults
    const relaysEnv = process.env.NOSTR_RELAYS;
    const relays = relaysEnv ? relaysEnv.split(',').map(r => r.trim()).filter(r => r.length > 0) : [
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

    if (subcommand === 'repo-announcement') {
      // publish repo-announcement <repo-name> --description <text> --clone-url <url> [--clone-url <url>...] [--web-url <url>...] [--maintainer <npub>...] [--relay <url>...]
      const repoName = args[1];
      if (!repoName) {
        console.error('Error: Repository name required');
        console.error('Use: publish repo-announcement <repo-name> [options]');
        process.exit(1);
      }

      const tags = [['d', repoName]];
      let description = '';
      const cloneUrls = [];
      const webUrls = [];
      const maintainers = [];

      // Parse options
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--description' && args[i + 1]) {
          description = args[++i];
        } else if (args[i] === '--clone-url' && args[i + 1]) {
          cloneUrls.push(args[++i]);
        } else if (args[i] === '--web-url' && args[i + 1]) {
          webUrls.push(args[++i]);
        } else if (args[i] === '--maintainer' && args[i + 1]) {
          maintainers.push(args[++i]);
        } else if (args[i] === '--relay' && args[i + 1]) {
          relays.push(args[++i]);
        }
      }

      // Add clone URLs
      for (const url of cloneUrls) {
        tags.push(['r', url]);
      }

      // Add web URLs
      for (const url of webUrls) {
        tags.push(['web', url]);
      }

      // Add maintainers
      for (const maintainer of maintainers) {
        tags.push(['p', maintainer]);
      }

      // Add client tag unless --no-client-tag is specified
      addClientTag(tags, args);

      const event = finalizeEvent({
        kind: 30617, // REPO_ANNOUNCEMENT
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: description
      }, privateKeyBytes);

      // Store event in JSONL file
      storeEventInJsonl(event);
      
      const result = await publishToRelays(event, relays, privateKeyBytes, pubkey);
      
      if (json) {
        console.log(JSON.stringify({ event, published: result }, null, 2));
      } else {
        console.log('Repository announcement published!');
        console.log(`Event ID: ${event.id}`);
        console.log(`Repository: ${repoName}`);
        console.log(`Event stored in nostr/repo-announcements.jsonl`);
        console.log(`Published to ${result.success.length} relay(s): ${result.success.join(', ')}`);
        if (result.failed.length > 0) {
          console.log(`Failed on ${result.failed.length} relay(s):`);
          result.failed.forEach(f => console.log(`  ${f.relay}: ${f.error}`));
        }
      }
    } else if (subcommand === 'ownership-transfer') {
      // publish ownership-transfer <repo> <new-owner-npub> [--self-transfer]
      // Note: The current owner is determined by the signing key (NOSTRGIT_SECRET_KEY)
      const [repoName, newOwnerNpub] = args.slice(1);
      if (!repoName || !newOwnerNpub) {
        console.error('Error: repo name and new owner npub required');
        console.error('Use: publish ownership-transfer <repo> <new-owner-npub> [--self-transfer]');
        console.error('Note: You must be the current owner (signing with NOSTRGIT_SECRET_KEY)');
        process.exit(1);
      }

      const selfTransfer = args.includes('--self-transfer');
      
      // Decode new owner npub to hex
      let newOwnerPubkey;
      try {
        newOwnerPubkey = newOwnerNpub.startsWith('npub') ? decode(newOwnerNpub).data : newOwnerNpub;
        // Convert to hex string if it's a Uint8Array
        if (newOwnerPubkey instanceof Uint8Array) {
          newOwnerPubkey = Array.from(newOwnerPubkey).map(b => b.toString(16).padStart(2, '0')).join('');
        }
      } catch (err) {
        throw new Error(`Invalid npub format: ${err.message}`);
      }

      // Current owner is the pubkey from the signing key
      const currentOwnerPubkey = pubkey;
      const repoAddress = `30617:${currentOwnerPubkey}:${repoName}`;
      const tags = [
        ['a', repoAddress],
        ['p', newOwnerPubkey],
        ['d', repoName]
      ];

      if (selfTransfer) {
        tags.push(['t', 'self-transfer']);
      }

      // Add client tag unless --no-client-tag is specified
      addClientTag(tags, args);

      const event = finalizeEvent({
        kind: 1641, // OWNERSHIP_TRANSFER
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: ''
      }, privateKeyBytes);

      // Store event in JSONL file
      storeEventInJsonl(event);
      
      const result = await publishToRelays(event, relays, privateKeyBytes, pubkey);
      
      if (json) {
        console.log(JSON.stringify({ event, published: result }, null, 2));
      } else {
        const currentOwnerNpub = nip19.npubEncode(currentOwnerPubkey);
        console.log('Ownership transfer published!');
        console.log(`Event ID: ${event.id}`);
        console.log(`Repository: ${currentOwnerNpub}/${repoName}`);
        console.log(`Current owner: ${currentOwnerNpub}`);
        console.log(`New owner: ${newOwnerNpub}`);
        console.log(`Event stored in nostr/ownership-transfers.jsonl`);
        console.log(`Published to ${result.success.length} relay(s): ${result.success.join(', ')}`);
        if (result.failed.length > 0) {
          console.log(`Failed on ${result.failed.length} relay(s):`);
          result.failed.forEach(f => console.log(`  ${f.relay}: ${f.error}`));
        }
      }
    } else if (subcommand === 'pr' || subcommand === 'pull-request') {
      // publish pr <npub> <repo> <title> [--content <text>] [--base <branch>] [--head <branch>]
      const [ownerNpub, repoName, title] = args.slice(1);
      if (!ownerNpub || !repoName || !title) {
        console.error('Error: owner npub, repo name, and title required');
        console.error('Use: publish pr <owner-npub> <repo> <title> [options]');
        process.exit(1);
      }

      let ownerPubkey;
      try {
        ownerPubkey = ownerNpub.startsWith('npub') ? decode(ownerNpub).data : ownerNpub;
      } catch (err) {
        throw new Error(`Invalid npub format: ${err.message}`);
      }

      const repoAddress = `30617:${ownerPubkey}:${repoName}`;
      const tags = [
        ['a', repoAddress],
        ['p', ownerPubkey],
        ['subject', title]
      ];

      let content = '';
      let baseBranch = 'main';
      let headBranch = 'main';

      for (let i = 4; i < args.length; i++) {
        if (args[i] === '--content' && args[i + 1]) {
          content = args[++i];
        } else if (args[i] === '--base' && args[i + 1]) {
          baseBranch = args[++i];
        } else if (args[i] === '--head' && args[i + 1]) {
          headBranch = args[++i];
        }
      }

      if (baseBranch !== headBranch) {
        tags.push(['base', baseBranch]);
        tags.push(['head', headBranch]);
      }

      // Add client tag unless --no-client-tag is specified
      addClientTag(tags, args);

      const event = finalizeEvent({
        kind: 1618, // PULL_REQUEST
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content
      }, privateKeyBytes);

      // Store event in JSONL file
      storeEventInJsonl(event);
      
      const result = await publishToRelays(event, relays, privateKeyBytes, pubkey);
      
      if (json) {
        console.log(JSON.stringify({ event, published: result }, null, 2));
      } else {
        console.log('Pull request published!');
        console.log(`Event ID: ${event.id}`);
        console.log(`Repository: ${ownerNpub}/${repoName}`);
        console.log(`Title: ${title}`);
        console.log(`Event stored in nostr/pull-requests.jsonl`);
        console.log(`Published to ${result.success.length} relay(s): ${result.success.join(', ')}`);
        if (result.failed.length > 0) {
          console.log(`Failed on ${result.failed.length} relay(s):`);
          result.failed.forEach(f => console.log(`  ${f.relay}: ${f.error}`));
        }
      }
    } else if (subcommand === 'issue') {
      // publish issue <npub> <repo> <title> [--content <text>] [--label <label>...]
      const [ownerNpub, repoName, title] = args.slice(1);
      if (!ownerNpub || !repoName || !title) {
        console.error('Error: owner npub, repo name, and title required');
        console.error('Use: publish issue <owner-npub> <repo> <title> [options]');
        process.exit(1);
      }

      let ownerPubkey;
      try {
        ownerPubkey = ownerNpub.startsWith('npub') ? decode(ownerNpub).data : ownerNpub;
      } catch (err) {
        throw new Error(`Invalid npub format: ${err.message}`);
      }

      const repoAddress = `30617:${ownerPubkey}:${repoName}`;
      const tags = [
        ['a', repoAddress],
        ['p', ownerPubkey],
        ['subject', title]
      ];

      let content = '';
      const labels = [];

      for (let i = 4; i < args.length; i++) {
        if (args[i] === '--content' && args[i + 1]) {
          content = args[++i];
        } else if (args[i] === '--label' && args[i + 1]) {
          labels.push(args[++i]);
        }
      }

      for (const label of labels) {
        tags.push(['t', label]);
      }

      // Add client tag unless --no-client-tag is specified
      addClientTag(tags, args);

      const event = finalizeEvent({
        kind: 1621, // ISSUE
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content
      }, privateKeyBytes);

      // Store event in JSONL file
      storeEventInJsonl(event);
      
      const result = await publishToRelays(event, relays, privateKeyBytes, pubkey);
      
      if (json) {
        console.log(JSON.stringify({ event, published: result }, null, 2));
      } else {
        console.log('Issue published!');
        console.log(`Event ID: ${event.id}`);
        console.log(`Repository: ${ownerNpub}/${repoName}`);
        console.log(`Title: ${title}`);
        console.log(`Event stored in nostr/issues.jsonl`);
        console.log(`Published to ${result.success.length} relay(s): ${result.success.join(', ')}`);
        if (result.failed.length > 0) {
          console.log(`Failed on ${result.failed.length} relay(s):`);
          result.failed.forEach(f => console.log(`  ${f.relay}: ${f.error}`));
        }
      }
    } else if (subcommand === 'status') {
      // publish status <event-id> <status> [--content <text>]
      // status: open|applied|closed|draft
      const [eventId, status] = args.slice(1);
      if (!eventId || !status) {
        console.error('Error: event ID and status required');
        console.error('Use: publish status <event-id> <open|applied|closed|draft> [--content <text>]');
        process.exit(1);
      }

      const statusKinds = {
        'open': 1630,
        'applied': 1631,
        'closed': 1632,
        'draft': 1633
      };

      const kind = statusKinds[status.toLowerCase()];
      if (!kind) {
        console.error(`Error: Invalid status. Use: open, applied, closed, or draft`);
        process.exit(1);
      }

      const tags = [['e', eventId]];
      let content = '';

      for (let i = 3; i < args.length; i++) {
        if (args[i] === '--content' && args[i + 1]) {
          content = args[++i];
        }
      }

      // Add client tag unless --no-client-tag is specified
      addClientTag(tags, args);

      const event = finalizeEvent({
        kind,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content
      }, privateKeyBytes);

      // Store event in JSONL file
      storeEventInJsonl(event);
      
      const result = await publishToRelays(event, relays, privateKeyBytes, pubkey);
      
      if (json) {
        console.log(JSON.stringify({ event, published: result }, null, 2));
      } else {
        console.log(`Status event published!`);
        console.log(`Event ID: ${event.id}`);
        console.log(`Status: ${status}`);
        console.log(`Target event: ${eventId}`);
        console.log(`Event stored in nostr/status-events.jsonl`);
        console.log(`Published to ${result.success.length} relay(s): ${result.success.join(', ')}`);
        if (result.failed.length > 0) {
          console.log(`Failed on ${result.failed.length} relay(s):`);
          result.failed.forEach(f => console.log(`  ${f.relay}: ${f.error}`));
        }
      }
    } else if (subcommand === 'patch') {
      // publish patch <owner-npub> <repo> <patch-file> [options]
      // Patch content should be from git format-patch
      const [ownerNpub, repoName, patchFile] = args.slice(1);
      if (!ownerNpub || !repoName || !patchFile) {
        console.error('Error: owner npub, repo name, and patch file required');
        console.error('Use: publish patch <owner-npub> <repo> <patch-file> [options]');
        console.error('Note: Patch file should be generated with: git format-patch');
        process.exit(1);
      }

      let ownerPubkey;
      try {
        ownerPubkey = ownerNpub.startsWith('npub') ? decode(ownerNpub).data : ownerNpub;
        if (ownerPubkey instanceof Uint8Array) {
          ownerPubkey = Array.from(ownerPubkey).map(b => b.toString(16).padStart(2, '0')).join('');
        }
      } catch (err) {
        throw new Error(`Invalid npub format: ${err.message}`);
      }

      // Read patch file
      let patchContent;
      try {
        patchContent = readFileSync(patchFile, 'utf-8');
      } catch (err) {
        throw new Error(`Failed to read patch file: ${err.message}`);
      }

      const repoAddress = `30617:${ownerPubkey}:${repoName}`;
      const tags = [
        ['a', repoAddress],
        ['p', ownerPubkey]
      ];

      // Parse options
      let earliestCommit = null;
      let commitId = null;
      let parentCommit = null;
      let isRoot = false;
      let isRootRevision = false;
      const mentions = [];

      for (let i = 4; i < args.length; i++) {
        if (args[i] === '--earliest-commit' && args[i + 1]) {
          earliestCommit = args[++i];
          tags.push(['r', earliestCommit]);
        } else if (args[i] === '--commit' && args[i + 1]) {
          commitId = args[++i];
          tags.push(['commit', commitId]);
          tags.push(['r', commitId]);
        } else if (args[i] === '--parent-commit' && args[i + 1]) {
          parentCommit = args[++i];
          tags.push(['parent-commit', parentCommit]);
        } else if (args[i] === '--root') {
          isRoot = true;
          tags.push(['t', 'root']);
        } else if (args[i] === '--root-revision') {
          isRootRevision = true;
          tags.push(['t', 'root-revision']);
        } else if (args[i] === '--mention' && args[i + 1]) {
          mentions.push(args[++i]);
        } else if (args[i] === '--reply-to' && args[i + 1]) {
          // NIP-10 reply tag
          tags.push(['e', args[++i], '', 'reply']);
        }
      }

      // Add earliest commit if provided
      if (earliestCommit) {
        tags.push(['r', earliestCommit, 'euc']);
      }

      // Add mentions
      for (const mention of mentions) {
        let mentionPubkey = mention;
        try {
          if (mention.startsWith('npub')) {
            mentionPubkey = decode(mention).data;
            if (mentionPubkey instanceof Uint8Array) {
              mentionPubkey = Array.from(mentionPubkey).map(b => b.toString(16).padStart(2, '0')).join('');
            }
          }
        } catch {
          // Keep original if decode fails
        }
        tags.push(['p', mentionPubkey]);
      }

      // Add client tag unless --no-client-tag is specified
      addClientTag(tags, args);

      const event = finalizeEvent({
        kind: 1617, // PATCH
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: patchContent
      }, privateKeyBytes);

      // Store event in JSONL file
      storeEventInJsonl(event);
      
      const result = await publishToRelays(event, relays, privateKeyBytes, pubkey);
      
      if (json) {
        console.log(JSON.stringify({ event, published: result }, null, 2));
      } else {
        console.log('Patch published!');
        console.log(`Event ID: ${event.id}`);
        console.log(`Repository: ${ownerNpub}/${repoName}`);
        console.log(`Patch file: ${patchFile}`);
        console.log(`Event stored in nostr/patches.jsonl`);
        console.log(`Published to ${result.success.length} relay(s): ${result.success.join(', ')}`);
        if (result.failed.length > 0) {
          console.log(`Failed on ${result.failed.length} relay(s):`);
          result.failed.forEach(f => console.log(`  ${f.relay}: ${f.error}`));
        }
      }
    } else if (subcommand === 'repo-state') {
      // publish repo-state <repo> [options]
      // Options: --ref <ref-path> <commit-id> [--parent <commit-id>...] --head <branch>
      const repoName = args[1];
      if (!repoName) {
        console.error('Error: Repository name required');
        console.error('Use: publish repo-state <repo> [options]');
        process.exit(1);
      }

      // Current owner is the pubkey from the signing key
      const currentOwnerPubkey = pubkey;
      const tags = [['d', repoName]];
      let headBranch = null;

      // Parse options
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--ref' && args[i + 2]) {
          const refPath = args[++i];
          const commitId = args[++i];
          const refTag = [refPath, commitId];
          
          // Check for parent commits
          while (i + 1 < args.length && args[i + 1] !== '--ref' && args[i + 1] !== '--head') {
            refTag.push(args[++i]);
          }
          
          tags.push(refTag);
        } else if (args[i] === '--head' && args[i + 1]) {
          headBranch = args[++i];
          tags.push(['HEAD', `ref: refs/heads/${headBranch}`]);
        }
      }

      // Add client tag unless --no-client-tag is specified
      addClientTag(tags, args);

      const event = finalizeEvent({
        kind: 30618, // REPO_STATE
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: ''
      }, privateKeyBytes);

      // Store event in JSONL file
      storeEventInJsonl(event);
      
      const result = await publishToRelays(event, relays, privateKeyBytes, pubkey);
      
      if (json) {
        console.log(JSON.stringify({ event, published: result }, null, 2));
      } else {
        const currentOwnerNpub = nip19.npubEncode(currentOwnerPubkey);
        console.log('Repository state published!');
        console.log(`Event ID: ${event.id}`);
        console.log(`Repository: ${currentOwnerNpub}/${repoName}`);
        if (headBranch) {
          console.log(`HEAD: ${headBranch}`);
        }
        console.log(`Refs: ${tags.filter(t => t[0].startsWith('refs/')).length}`);
        console.log(`Event stored in nostr/repo-states.jsonl`);
        console.log(`Published to ${result.success.length} relay(s): ${result.success.join(', ')}`);
        if (result.failed.length > 0) {
          console.log(`Failed on ${result.failed.length} relay(s):`);
          result.failed.forEach(f => console.log(`  ${f.relay}: ${f.error}`));
        }
      }
    } else if (subcommand === 'pr-update' || subcommand === 'pull-request-update') {
      // publish pr-update <owner-npub> <repo> <pr-event-id> <commit-id> [options]
      const [ownerNpub, repoName, prEventId, commitId] = args.slice(1);
      if (!ownerNpub || !repoName || !prEventId || !commitId) {
        console.error('Error: owner npub, repo name, PR event ID, and commit ID required');
        console.error('Use: publish pr-update <owner-npub> <repo> <pr-event-id> <commit-id> [options]');
        process.exit(1);
      }

      let ownerPubkey;
      try {
        ownerPubkey = ownerNpub.startsWith('npub') ? decode(ownerNpub).data : ownerNpub;
        if (ownerPubkey instanceof Uint8Array) {
          ownerPubkey = Array.from(ownerPubkey).map(b => b.toString(16).padStart(2, '0')).join('');
        }
      } catch (err) {
        throw new Error(`Invalid npub format: ${err.message}`);
      }

      // Get PR author pubkey (needed for NIP-22 tags)
      // For now, we'll require it as an option or try to get it from the PR event
      let prAuthorPubkey = null;
      const cloneUrls = [];
      let mergeBase = null;
      let earliestCommit = null;
      const mentions = [];

      for (let i = 5; i < args.length; i++) {
        if (args[i] === '--pr-author' && args[i + 1]) {
          let authorNpub = args[++i];
          try {
            prAuthorPubkey = authorNpub.startsWith('npub') ? decode(authorNpub).data : authorNpub;
            if (prAuthorPubkey instanceof Uint8Array) {
              prAuthorPubkey = Array.from(prAuthorPubkey).map(b => b.toString(16).padStart(2, '0')).join('');
            }
          } catch (err) {
            throw new Error(`Invalid pr-author npub format: ${err.message}`);
          }
        } else if (args[i] === '--clone-url' && args[i + 1]) {
          cloneUrls.push(args[++i]);
        } else if (args[i] === '--merge-base' && args[i + 1]) {
          mergeBase = args[++i];
        } else if (args[i] === '--earliest-commit' && args[i + 1]) {
          earliestCommit = args[++i];
        } else if (args[i] === '--mention' && args[i + 1]) {
          mentions.push(args[++i]);
        }
      }

      const repoAddress = `30617:${ownerPubkey}:${repoName}`;
      const tags = [
        ['a', repoAddress],
        ['p', ownerPubkey],
        ['E', prEventId], // NIP-22 root event reference
        ['c', commitId]
      ];

      // Add earliest commit if provided
      if (earliestCommit) {
        tags.push(['r', earliestCommit, 'euc']);
      }

      // Add mentions
      for (const mention of mentions) {
        let mentionPubkey = mention;
        try {
          if (mention.startsWith('npub')) {
            mentionPubkey = decode(mention).data;
            if (mentionPubkey instanceof Uint8Array) {
              mentionPubkey = Array.from(mentionPubkey).map(b => b.toString(16).padStart(2, '0')).join('');
            }
          }
        } catch {
          // Keep original if decode fails
        }
        tags.push(['p', mentionPubkey]);
      }

      // Add PR author if provided (NIP-22 root pubkey reference)
      if (prAuthorPubkey) {
        tags.push(['P', prAuthorPubkey]);
      }

      // Add clone URLs (required)
      if (cloneUrls.length === 0) {
        console.error('Error: At least one --clone-url is required');
        process.exit(1);
      }
      for (const url of cloneUrls) {
        tags.push(['clone', url]);
      }

      // Add merge base if provided
      if (mergeBase) {
        tags.push(['merge-base', mergeBase]);
      }

      // Add client tag unless --no-client-tag is specified
      addClientTag(tags, args);

      const event = finalizeEvent({
        kind: 1619, // PULL_REQUEST_UPDATE
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: ''
      }, privateKeyBytes);

      // Store event in JSONL file
      storeEventInJsonl(event);
      
      const result = await publishToRelays(event, relays, privateKeyBytes, pubkey);
      
      if (json) {
        console.log(JSON.stringify({ event, published: result }, null, 2));
      } else {
        console.log('Pull request update published!');
        console.log(`Event ID: ${event.id}`);
        console.log(`Repository: ${ownerNpub}/${repoName}`);
        console.log(`PR Event ID: ${prEventId}`);
        console.log(`New commit: ${commitId}`);
        console.log(`Event stored in nostr/pull-request-updates.jsonl`);
        console.log(`Published to ${result.success.length} relay(s): ${result.success.join(', ')}`);
        if (result.failed.length > 0) {
          console.log(`Failed on ${result.failed.length} relay(s):`);
          result.failed.forEach(f => console.log(`  ${f.relay}: ${f.error}`));
        }
      }
    } else if (subcommand === 'event') {
      // Generic event publishing
      
      // Check for help
      if (args.slice(1).includes('--help') || args.slice(1).includes('-h')) {
        console.log(`
Publish Generic Nostr Event

Usage: gitrep publish event [content] [options]

Description:
  Publish a generic Nostr event with any kind, content, and tags.
  Defaults to kind 1 (text note) if not specified.
  Content can be provided as a positional argument or with --content.

Options:
  --kind <number>              Event kind (default: 1)
  --content <text>             Event content (default: '')
  --tag <name> <value>         Add a tag (can be specified multiple times)
  --no-client-tag              Don't add client tag (default: adds 'client' tag)
  --relay <url>                Custom relay URL (can be specified multiple times)
  --help, -h                   Show this help message

Examples:
  gitrep publish event "Hello, Nostr!"                    # Simple text note
  gitrep publish event --kind 1 --content "Hello, Nostr!"
  gitrep publish event --kind 1 --content "Hello" --tag "p" "npub1..."
  gitrep publish event --kind 42 "" --tag "t" "hashtag" --tag "p" "npub1..."
  gitrep publish event "Test" --no-client-tag
  gitrep publish event "Test" --relay "wss://relay.example.com"

Notes:
  - All events are automatically signed with NOSTRGIT_SECRET_KEY
  - Events are stored locally in nostr/events-kind-<kind>.jsonl
  - Client tag is added by default unless --no-client-tag is specified
`);
        process.exit(0);
      }

      let kind = 1; // Default to kind 1
      let content = '';
      const tags = [];
      const customRelays = [];
      let positionalContent = null;

      // Parse options and positional arguments
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--kind' && args[i + 1]) {
          kind = parseInt(args[++i], 10);
          if (isNaN(kind)) {
            console.error('Error: --kind must be a number');
            process.exit(1);
          }
        } else if (args[i] === '--content' && args[i + 1] !== undefined) {
          content = args[++i];
        } else if (args[i] === '--tag' && args[i + 1] && args[i + 2]) {
          const tagName = args[++i];
          const tagValue = args[++i];
          tags.push([tagName, tagValue]);
        } else if (args[i] === '--relay' && args[i + 1]) {
          customRelays.push(args[++i]);
        } else if (args[i] === '--no-client-tag') {
          // Handled by addClientTag function
        } else if (args[i] === '--help' || args[i] === '-h') {
          // Already handled above
        } else if (!args[i].startsWith('--')) {
          // Positional argument - treat as content if no --content was specified
          if (positionalContent === null && content === '') {
            positionalContent = args[i];
          } else {
            console.error(`Error: Unexpected positional argument: ${args[i]}`);
            console.error('Use: publish event [content] [options]');
            console.error('Run: publish event --help for detailed usage');
            process.exit(1);
          }
        } else {
          console.error(`Error: Unknown option: ${args[i]}`);
          console.error('Use: publish event [content] [options]');
          console.error('Run: publish event --help for detailed usage');
          process.exit(1);
        }
      }

      // Use positional content if provided and --content was not used
      if (positionalContent !== null && content === '') {
        content = positionalContent;
      }

      // Add client tag unless --no-client-tag is specified
      addClientTag(tags, args);

      // Use custom relays if provided, otherwise use defaults
      const eventRelays = customRelays.length > 0 ? customRelays : relays;

      const event = finalizeEvent({
        kind,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content
      }, privateKeyBytes);

      // Store event in JSONL file
      storeEventInJsonl(event);
      
      let result;
      try {
        result = await publishToRelays(event, eventRelays, privateKeyBytes, pubkey);
      } catch (error) {
        // Handle relay errors gracefully - don't crash
        const errorMessage = error instanceof Error ? error.message : String(error);
        result = {
          success: [],
          failed: eventRelays.map(relay => ({ relay, error: errorMessage }))
        };
      }
      
      if (json) {
        console.log(JSON.stringify({ event, published: result }, null, 2));
      } else {
        console.log('Event published!');
        console.log(`Event ID: ${event.id}`);
        console.log(`Kind: ${kind}`);
        console.log(`Content: ${content || '(empty)'}`);
        console.log(`Tags: ${tags.length}`);
        console.log(`Event stored in nostr/events-kind-${kind}.jsonl`);
        if (result.success.length > 0) {
          console.log(`Published to ${result.success.length} relay(s): ${result.success.join(', ')}`);
        }
        if (result.failed.length > 0) {
          console.log(`Failed on ${result.failed.length} relay(s):`);
          result.failed.forEach(f => console.log(`  ${f.relay}: ${f.error}`));
        }
        // Exit with error code only if all relays failed
        if (result.success.length === 0 && result.failed.length > 0) {
          process.exit(1);
        }
      }
    } else {
      console.error(`Error: Unknown publish subcommand: ${subcommand}`);
      console.error('Use: publish repo-announcement|ownership-transfer|pr|pr-update|issue|status|patch|repo-state|event');
      console.error('Run: publish --help for detailed usage');
      process.exit(1);
    }
  },

  async verify(args, server, json) {
    // verify <event-file> or verify <event-json>
    const input = args[0];
    if (!input) {
      console.error('Error: Event file path or JSON required');
      console.error('Use: verify <event-file.jsonl> or verify <event-json>');
      process.exit(1);
    }

    let event;
    try {
      // Try to read as file first
      if (existsSync(input)) {
        const content = readFileSync(input, 'utf-8').trim();
        // If it's JSONL, get the last line (most recent event)
        const lines = content.split('\n').filter(l => l.trim());
        const lastLine = lines[lines.length - 1];
        event = JSON.parse(lastLine);
      } else {
        // Try to parse as JSON directly
        event = JSON.parse(input);
      }
    } catch (err) {
      console.error(`Error: Failed to parse event: ${err instanceof Error ? err.message : 'Unknown error'}`);
      process.exit(1);
    }

    // Verify event
    const signatureValid = verifyEvent(event);
    const computedId = getEventHash(event);
    const idMatches = event.id === computedId;

    if (json) {
      console.log(JSON.stringify({
        valid: signatureValid && idMatches,
        signatureValid,
        idMatches,
        computedId,
        eventId: event.id,
        kind: event.kind,
        pubkey: event.pubkey,
        created_at: event.created_at,
        timestamp: new Date(event.created_at * 1000).toLocaleString(),
        timestamp_utc: new Date(event.created_at * 1000).toISOString()
      }, null, 2));
    } else {
      console.log('Event Verification:');
      console.log(`  Kind: ${event.kind}`);
      console.log(`  Pubkey: ${event.pubkey.substring(0, 16)}...`);
      console.log(`  Created: ${new Date(event.created_at * 1000).toLocaleString()}`);
      console.log(`  Event ID: ${event.id.substring(0, 16)}...`);
      console.log('');
      console.log('Verification Results:');
      console.log(`  Signature valid: ${signatureValid ? '✅ Yes' : '❌ No'}`);
      console.log(`  Event ID matches: ${idMatches ? '✅ Yes' : '❌ No'}`);
      if (!idMatches) {
        console.log(`  Computed ID: ${computedId}`);
        console.log(`  Expected ID: ${event.id}`);
      }
      console.log('');
      
      if (signatureValid && idMatches) {
        console.log('✅ Event is VALID');
      } else {
        console.log('❌ Event is INVALID');
        if (!signatureValid) {
          console.log('  - Signature verification failed');
        }
        if (!idMatches) {
          console.log('  - Event ID does not match computed hash');
        }
        process.exit(1);
      }
    }
  },

  async pushAll(args, server, json) {
    // push-all [branch] [--force] [--tags] [--dry-run] - Push to all remotes
    
    // Check for help flag
    if (args.includes('--help') || args.includes('-h')) {
      console.log(`Push to All Remotes

Usage: gitrep push-all [branch] [options]

Description:
  Pushes the current branch (or specified branch) to all configured git remotes.
  This is useful when you have multiple remotes (e.g., GitHub, GitLab, GitRepublic)
  and want to push to all of them at once.

Arguments:
  branch                    Optional branch name to push. If not specified, pushes all branches.

Options:
  --force, -f               Force push (use with caution)
  --tags                    Also push tags
  --dry-run, -n             Show what would be pushed without actually pushing
  --help, -h                Show this help message

Examples:
  gitrep push-all                    Push all branches to all remotes
  gitrep push-all main               Push main branch to all remotes
  gitrep push-all main --force       Force push main branch to all remotes
  gitrep push-all --tags             Push all branches and tags to all remotes
  gitrep push-all main --dry-run     Show what would be pushed without pushing

Notes:
  - This command requires you to be in a git repository
  - It will push to all remotes listed by 'git remote'
  - If any remote fails, the command will exit with an error code
  - Use --dry-run to test before actually pushing
`);
      return; // Exit the function (process.exit is handled by the caller)
    }
    
    // Parse arguments
    const branch = args.find(arg => !arg.startsWith('--'));
    const force = args.includes('--force') || args.includes('-f');
    const tags = args.includes('--tags');
    const dryRun = args.includes('--dry-run') || args.includes('-n');
    
    // Get all remotes
    let remotes = [];
    try {
      const remoteOutput = execSync('git remote', { encoding: 'utf-8' }).trim();
      remotes = remoteOutput.split('\n').filter(r => r.trim());
    } catch (err) {
      console.error('Error: Not in a git repository or unable to read remotes');
      console.error(err instanceof Error ? err.message : 'Unknown error');
      process.exit(1);
    }
    
    if (remotes.length === 0) {
      console.error('Error: No remotes configured');
      process.exit(1);
    }
    
    // Build push command
    const pushArgs = [];
    if (force) pushArgs.push('--force');
    if (tags) pushArgs.push('--tags');
    if (dryRun) pushArgs.push('--dry-run');
    if (branch) {
      // If branch is specified, push to each remote with that branch
      pushArgs.push(branch);
    } else {
      // Push all branches
      pushArgs.push('--all');
    }
    
    const results = [];
    let successCount = 0;
    let failCount = 0;
    
    for (const remote of remotes) {
      try {
        if (!json && !dryRun) {
          console.log(`\nPushing to ${remote}...`);
        }
        
        const command = ['push', remote, ...pushArgs];
        
        execSync(`git ${command.join(' ')}`, {
          stdio: json ? 'pipe' : 'inherit',
          encoding: 'utf-8'
        });
        
        results.push({ remote, status: 'success' });
        successCount++;
        
        if (!json && !dryRun) {
          console.log(`✅ Successfully pushed to ${remote}`);
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        results.push({ remote, status: 'failed', error: errorMessage });
        failCount++;
        
        if (!json && !dryRun) {
          console.error(`❌ Failed to push to ${remote}: ${errorMessage}`);
        }
      }
    }
    
    if (json) {
      console.log(JSON.stringify({
        total: remotes.length,
        success: successCount,
        failed: failCount,
        results
      }, null, 2));
    } else {
      console.log('\n' + '='.repeat(70));
      console.log(`Push Summary: ${successCount} succeeded, ${failCount} failed out of ${remotes.length} remotes`);
      console.log('='.repeat(70));
      
      if (failCount > 0) {
        console.log('\nFailed remotes:');
        results.filter(r => r.status === 'failed').forEach(r => {
          console.log(`  ${r.remote}: ${r.error}`);
        });
        process.exit(1);
      }
    }
  }
};

// Main execution
const args = process.argv.slice(2);
const commandIndex = args.findIndex(arg => !arg.startsWith('--'));
const command = commandIndex >= 0 ? args[commandIndex] : null;
const commandArgs = commandIndex >= 0 ? args.slice(commandIndex + 1) : [];

// Parse options
const serverIndex = args.indexOf('--server');
const server = serverIndex >= 0 && args[serverIndex + 1] ? args[serverIndex + 1] : DEFAULT_SERVER;
const json = args.includes('--json');
// Check if --help or -h is in command args (after command) - if so, it's command-specific help
const commandHelpRequested = command && (commandArgs.includes('--help') || commandArgs.includes('-h'));
// Only treat as general help if --help or -h is before the command or there's no command
const help = !commandHelpRequested && (args.includes('--help') || args.includes('-h'));

// Add config command
if (command === 'config') {
  const subcommand = commandArgs[0];
  if (subcommand === 'server' || !subcommand) {
    if (json) {
      console.log(JSON.stringify({ server, default: DEFAULT_SERVER, fromEnv: !!process.env.GITREPUBLIC_SERVER }, null, 2));
    } else {
      console.log('GitRepublic Server Configuration:');
      console.log(`  Current: ${server}`);
      console.log(`  Default: ${DEFAULT_SERVER}`);
      if (process.env.GITREPUBLIC_SERVER) {
        console.log(`  From environment: ${process.env.GITREPUBLIC_SERVER}`);
      } else {
        console.log('  From environment: (not set)');
        console.log('  ⚠️  Note: Default is for development only (localhost:5173)');
        console.log('  ⚠️  Set GITREPUBLIC_SERVER for production use');
      }
      console.log('');
      console.log('To change the server:');
      console.log('  gitrep --server <url> <command> (or gitrepublic)');
      console.log('  export GITREPUBLIC_SERVER=<url>');
    }
    process.exit(0);
  } else {
    console.error('Invalid config command. Use: config [server]');
    process.exit(1);
  }
}

// Convert kebab-case to camelCase for command lookup (do this before help check)
const commandKey = command ? command.replace(/-([a-z])/g, (g) => g[1].toUpperCase()) : null;
const commandHandler = commandKey ? (commands[commandKey] || commands[command]) : null;

// If help is requested for a specific command, let the handler deal with it
if (commandHelpRequested && commandHandler) {
  // The handler will check for --help and show command-specific help
  commandHandler(commandArgs, server, json).catch(error => {
    console.error('Error:', error.message);
    process.exit(1);
  });
  // Exit after handler processes help (handler should exit, but just in case)
  process.exit(0);
}

if (help || !command || !commandHandler) {
  console.log(`GitRepublic CLI

Usage: gitrep <command> [options] (or gitrepublic)

Commands:
  config [server]               Show configuration (server URL)
  repos list                    List repositories
  repos get <npub> <repo>       Get repository info (or use naddr: repos get <naddr>)
  repos settings <npub> <repo> [--description <text>] [--private <true|false>]  Get/update settings
  repos maintainers <npub> <repo> [add|remove <npub>]  Manage maintainers
  repos branches <npub> <repo>  List branches
  repos tags <npub> <repo>      List tags
  repos fork <npub> <repo>      Fork a repository
  repos delete <npub> <repo>    Delete a repository
  file get <npub> <repo> <path> [branch]  Get file content
  file put <npub> <repo> <path> [file] [message] [branch]  Create/update file
  file delete <npub> <repo> <path> [message] [branch]  Delete file
  search <query>                Search repositories
  publish <subcommand> [options]  Publish Nostr Git events (use: publish --help for details)
  verify <event-file>|<event-json>  Verify a Nostr event signature and ID
  push-all [branch] [--force] [--tags] [--dry-run]  Push to all configured remotes

Options:
  --server <url>                GitRepublic server URL (default: ${DEFAULT_SERVER})
  --json                        Output JSON format
  --help                        Show this help

Environment variables:
  NOSTRGIT_SECRET_KEY           Nostr private key (nsec or hex)
  GITREPUBLIC_SERVER            Default server URL
  NOSTR_RELAYS                  Comma-separated list of Nostr relays (default: wss://theforest.nostr1.com,wss://relay.damus.io,wss://nostr.land)

Documentation: https://github.com/silberengel/gitrepublic-cli
GitCitadel: Visit us on GitHub: https://github.com/ShadowySupercode or on our homepage: https://gitcitadel.com

GitRepublic CLI - Copyright (c) 2026 GitCitadel LLC
Licensed under MIT License
`);
  process.exit(help ? 0 : 1);
}

// Execute command

if (!commandHandler) {
  console.error(`Error: Unknown command: ${command}`);
  console.error('Use --help to see available commands');
  process.exit(1);
}

commandHandler(commandArgs, server, json).catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
