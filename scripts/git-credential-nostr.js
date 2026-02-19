#!/usr/bin/env node
/**
 * Git credential helper for GitRepublic using NIP-98 authentication
 * 
 * This script implements the git credential helper protocol to automatically
 * generate NIP-98 authentication tokens for git operations.
 * 
 * Usage:
 *   1. Install dependencies: npm install
 *   2. Configure git:
 *      git config --global credential.helper '!node /path/to/gitrepublic-cli/scripts/git-credential-nostr.js'
 *   3. Or for a specific domain:
 *      git config --global credential.https://your-domain.com.helper '!node /path/to/gitrepublic-cli/scripts/git-credential-nostr.js'
 * 
 * Environment variables:
 *   NOSTRGIT_SECRET_KEY - Your Nostr private key (nsec format or hex) for client-side git operations
 * 
 * Security: Keep your NOSTRGIT_SECRET_KEY secure and never commit it to version control!
 */

import { createHash } from 'crypto';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { decode } from 'nostr-tools/nip19';
import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

// NIP-98 auth event kind
const KIND_NIP98_AUTH = 27235;

/**
 * Read input from stdin (git credential helper protocol)
 */
function readInput() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  
  return new Promise((resolve) => {
    process.stdin.on('readable', () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        chunks.push(chunk);
      }
    });
    
    process.stdin.on('end', () => {
      const input = chunks.join('');
      const lines = input.trim().split('\n');
      const data = {};
      
      for (const line of lines) {
        if (!line) continue;
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
          data[key] = valueParts.join('=');
        }
      }
      
      resolve(data);
    });
  });
}

/**
 * Try to extract the git remote URL path from .git/config
 * This is used as a fallback when git calls us with wwwauth[] but no path
 */
function tryGetPathFromGitRemote(host, protocol) {
  try {
    // Git sets GIT_DIR environment variable when calling credential helpers
    // Use it if available, otherwise try to find .git directory
    let gitDir = process.env.GIT_DIR;
    let configPath = null;
    
    if (gitDir) {
      // GIT_DIR might point directly to .git directory or to the config file
      if (existsSync(gitDir) && existsSync(join(gitDir, 'config'))) {
        configPath = join(gitDir, 'config');
      } else if (existsSync(gitDir) && gitDir.endsWith('config')) {
        configPath = gitDir;
      }
    }
    
    // If GIT_DIR didn't work, try to find .git directory starting from current working directory
    if (!configPath) {
      let currentDir = process.cwd();
      const maxDepth = 10; // Limit search depth
      let depth = 0;
      
      while (depth < maxDepth) {
        const potentialGitDir = join(currentDir, '.git');
        if (existsSync(potentialGitDir) && existsSync(join(potentialGitDir, 'config'))) {
          configPath = join(potentialGitDir, 'config');
          break;
        }
        
        // Move up one directory
        const parentDir = resolve(currentDir, '..');
        if (parentDir === currentDir) {
          // Reached filesystem root
          break;
        }
        currentDir = parentDir;
        depth++;
      }
    }
    
    if (!configPath || !existsSync(configPath)) {
      return null;
    }
    
    // Read git config
    const config = readFileSync(configPath, 'utf-8');
    
    // Find remotes that match our host
    // Match: [remote "name"] ... url = http://host/path
    const remoteRegex = /\[remote\s+"([^"]+)"\][\s\S]*?url\s*=\s*([^\n]+)/g;
    let match;
    while ((match = remoteRegex.exec(config)) !== null) {
      const remoteUrl = match[2].trim();
      
      // Check if this remote URL matches our host
      try {
        const url = new URL(remoteUrl);
        const remoteHost = url.hostname + (url.port ? ':' + url.port : '');
        if (url.host === host || remoteHost === host) {
          // Extract path from remote URL
          let path = url.pathname;
          if (path && path.includes('git-receive-pack')) {
            // Already has git-receive-pack in path
            return path;
          } else if (path && path.endsWith('.git')) {
            // Add git-receive-pack to path
            return path + '/git-receive-pack';
          } else if (path) {
            // Path exists but doesn't end with .git, try adding /git-receive-pack
            return path + '/git-receive-pack';
          }
        }
      } catch (e) {
        // Not a valid URL, skip
        continue;
      }
    }
  } catch (err) {
    // If anything fails, return null silently
  }
  
  return null;
}

/**
 * Normalize URL for NIP-98 (remove trailing slashes, ensure consistent format)
 * This must match the normalization used by the server in nip98-auth.ts
 */
function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    // Remove trailing slash from pathname (must match server normalization)
    parsed.pathname = parsed.pathname.replace(/\/$/, '');
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Calculate SHA256 hash of request body
 */
function calculateBodyHash(body) {
  if (!body) return null;
  const buffer = Buffer.from(body, 'utf-8');
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Create and sign a NIP-98 authentication event
 * @param privateKeyBytes - Private key as Uint8Array (32 bytes)
 * @param url - Request URL
 * @param method - HTTP method (GET, POST, etc.)
 * @param bodyHash - Optional SHA256 hash of request body (for POST requests)
 */
function createNIP98AuthEvent(privateKeyBytes, url, method, bodyHash = null) {
  const pubkey = getPublicKey(privateKeyBytes);
  const tags = [
    ['u', normalizeUrl(url)],
    ['method', method.toUpperCase()]
  ];
  
  if (bodyHash) {
    tags.push(['payload', bodyHash]);
  }
  
  const eventTemplate = {
    kind: KIND_NIP98_AUTH,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags
  };
  
  // Sign the event using finalizeEvent (which computes id and sig)
  const signedEvent = finalizeEvent(eventTemplate, privateKeyBytes);
  
  return signedEvent;
}

/**
 * Main credential helper logic
 */
async function main() {
  try {
    // Read input from git
    const input = await readInput();
    
    // Get command (get, store, erase)
    const command = process.argv[2] || 'get';
    
    // For 'get' command, generate credentials
    if (command === 'get') {
      // Get private key from environment variable
      // Support NOSTRGIT_SECRET_KEY (preferred), with fallbacks for backward compatibility
      const nsec = process.env.NOSTRGIT_SECRET_KEY || process.env.NOSTR_PRIVATE_KEY || process.env.NSEC;
      if (!nsec) {
        console.error('Error: NOSTRGIT_SECRET_KEY environment variable is not set');
        console.error('Set it with: export NOSTRGIT_SECRET_KEY="nsec1..." or NOSTRGIT_SECRET_KEY="<hex-key>"');
        process.exit(1);
      }
      
      // Parse private key (handle both nsec and hex formats)
      // Convert to Uint8Array for nostr-tools functions
      let privateKeyBytes;
      if (nsec.startsWith('nsec')) {
        try {
          const decoded = decode(nsec);
          if (decoded.type === 'nsec') {
            // decoded.data is already Uint8Array for nsec
            privateKeyBytes = decoded.data;
          } else {
            throw new Error('Invalid nsec format - decoded type is not nsec');
          }
        } catch (err) {
          console.error('Error decoding nsec:', err.message);
          process.exit(1);
        }
      } else {
        // Assume hex format (32 bytes = 64 hex characters)
        if (nsec.length !== 64) {
          console.error('Error: Hex private key must be 64 characters (32 bytes)');
          process.exit(1);
        }
        // Convert hex string to Uint8Array
        privateKeyBytes = new Uint8Array(32);
        for (let i = 0; i < 32; i++) {
          privateKeyBytes[i] = parseInt(nsec.slice(i * 2, i * 2 + 2), 16);
        }
      }
      
      // Extract URL components from input
      // Git credential helper protocol passes: protocol, host, path (and sometimes username, password)
      // Git may provide either individual attributes (protocol, host, path) or a url attribute
      // If we have a url, use it; otherwise construct from individual attributes
      let url;
      if (input.url) {
        // Git provided a url attribute - use it directly
        url = input.url;
      } else {
        // Construct URL from individual attributes
        const protocol = input.protocol || 'https';
        const host = input.host;
        let path = input.path || '';
        const wwwauth = input['wwwauth[]'] || input.wwwauth;
        
        if (!host) {
          console.error('Error: No host specified in credential request');
          process.exit(1);
        }
        
        // If path is missing, try to extract it from git remote URL
        // This happens when git calls us reactively after a 401 with wwwauth[] but no path
        if (!path) {
          if (wwwauth) {
            // Try to get path from git remote URL
            const extractedPath = tryGetPathFromGitRemote(host, protocol);
            if (extractedPath) {
              path = extractedPath;
            } else {
              // Exit without output - git should call us again with the full path when it retries
              process.exit(0);
            }
          } else {
            // Exit without output - git will call us again with the full path
            process.exit(0);
          }
        }
        
        // Build full URL (include query string if present)
        const query = input.query || '';
        const fullPath = query ? `${path}?${query}` : path;
        url = `${protocol}://${host}${fullPath}`;
      }
      
      // Parse URL to extract components for method detection
      let urlPath = '';
      try {
        const urlObj = new URL(url);
        urlPath = urlObj.pathname;
      } catch (err) {
        // If URL parsing fails, try to extract path from the URL string
        const match = url.match(/https?:\/\/[^\/]+(\/.*)/);
        urlPath = match ? match[1] : '';
      }
      
      // Determine HTTP method based on git operation
      // Git credential helper doesn't know the HTTP method, but we can infer it:
      // - If path contains 'git-receive-pack', it's a push (POST)
      // - If path contains 'git-upload-pack', it's a fetch (GET)
      // - For info/refs requests, check the service query parameter
      let method = 'GET';
      let authUrl = url; // The URL for which we generate credentials
      
      // Parse query string from URL if present
      let query = '';
      try {
        const urlObj = new URL(url);
        query = urlObj.search.slice(1); // Remove leading '?'
      } catch (err) {
        // If URL parsing fails, try to extract query from the URL string
        const match = url.match(/\?(.+)$/);
        query = match ? match[1] : '';
      }
      
      if (urlPath.includes('git-receive-pack')) {
        // Direct POST request to git-receive-pack
        method = 'POST';
        authUrl = url;
      } else if (urlPath.includes('git-upload-pack')) {
        // Direct GET request to git-upload-pack
        method = 'GET';
        authUrl = url;
      } else if (query.includes('service=git-receive-pack')) {
        // info/refs?service=git-receive-pack - this is a GET request
        // However, git might not call us again for the POST request
        // So we need to generate credentials for the POST request that will happen next
        // Replace info/refs with git-receive-pack in the path
        try {
          const urlObj = new URL(url);
          urlObj.pathname = urlObj.pathname.replace(/\/info\/refs$/, '/git-receive-pack');
          urlObj.search = ''; // Remove query string for POST request
          authUrl = urlObj.toString();
        } catch (err) {
          // Fallback: string replacement
          authUrl = url.replace(/\/info\/refs(\?.*)?$/, '/git-receive-pack');
        }
        method = 'POST';
      } else {
        // Default: GET request (info/refs, etc.)
        method = 'GET';
        authUrl = url;
      }
      
      // Normalize the URL before creating the event (must match server normalization)
      const normalizedAuthUrl = normalizeUrl(authUrl);
      
      // Create and sign NIP-98 auth event
      const authEvent = createNIP98AuthEvent(privateKeyBytes, normalizedAuthUrl, method);
      
      // Encode event as base64
      const eventJson = JSON.stringify(authEvent);
      const base64Event = Buffer.from(eventJson, 'utf-8').toString('base64');
      
      // Output credentials in git credential helper format
      // Username can be anything (git doesn't use it for NIP-98)
      // Password is the base64-encoded signed event
      console.log('username=nostr');
      console.log(`password=${base64Event}`);
      
    } else if (command === 'store') {
      // For 'store', we don't store credentials because NIP-98 requires per-request credentials
      // The URL and method are part of the signed event, so we can't reuse credentials
      // However, we should NOT prevent git from storing - let other credential helpers handle it
      // We just exit successfully without storing anything ourselves
      // This allows git to call us again for each request
      process.exit(0);
    } else if (command === 'erase') {
      // For 'erase', we don't need to do anything
      // Just exit successfully
      process.exit(0);
    } else {
      console.error(`Error: Unknown command: ${command}`);
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Run main function
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
