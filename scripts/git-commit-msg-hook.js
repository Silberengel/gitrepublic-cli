#!/usr/bin/env node
/**
 * Git commit-msg hook for signing commits with Nostr keys
 * 
 * This hook automatically signs git commits using your Nostr private key.
 * By default, it signs ALL commits (GitHub, GitLab, GitRepublic, etc.) since
 * the signature is just text in the commit message and doesn't interfere with
 * git operations.
 * 
 * Setup:
 *   1. Install dependencies: npm install
 *   2. Install as a git hook in your repository:
 *      ln -s /absolute/path/to/gitrepublic-cli/scripts/git-commit-msg-hook.js .git/hooks/commit-msg
 *   3. Or install globally for all repositories:
 *      mkdir -p ~/.git-hooks
 *      ln -s /absolute/path/to/gitrepublic-cli/scripts/git-commit-msg-hook.js ~/.git-hooks/commit-msg
 *      git config --global core.hooksPath ~/.git-hooks
 * 
 * Environment variables:
 *   NOSTRGIT_SECRET_KEY - Your Nostr private key (nsec format or hex) for signing commits
 *   GITREPUBLIC_SIGN_ONLY_GITREPUBLIC - If true, only sign GitRepublic repos (default: false, signs all)
 *   GITREPUBLIC_CANCEL_ON_SIGN_FAIL - If true, cancel commit if signing fails (default: false, allows unsigned)
 *   GITREPUBLIC_INCLUDE_FULL_EVENT - If true, include full event JSON in commit message (default: false, stored in nostr/commit-signatures.jsonl by default)
 *   GITREPUBLIC_PUBLISH_EVENT - If true, publish commit signature event to Nostr relays (default: false)
 *   NOSTR_RELAYS - Comma-separated list of Nostr relays for publishing (default: wss://theforest.nostr1.com,wss://relay.damus.io,wss://nostr.land)
 * 
 * By default, the full event JSON is stored in nostr/commit-signatures.jsonl (JSON Lines format).
 * Events are organized by type in the nostr/ folder for easy searching.
 * 
 * Security: Keep your NOSTRGIT_SECRET_KEY secure and never commit it to version control!
 */

import { finalizeEvent, getPublicKey, SimplePool, nip19 } from 'nostr-tools';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname, resolve } from 'path';

// Commit signature event kind (1640)
const KIND_COMMIT_SIGNATURE = 1640;

/**
 * Decode a Nostr key from bech32 (nsec) or hex format
 * Returns the hex-encoded private key as Uint8Array
 */
function decodeNostrKey(key) {
  let hexKey;
  
  // Check if it's already hex (64 characters, hex format)
  if (/^[0-9a-fA-F]{64}$/.test(key)) {
    hexKey = key.toLowerCase();
  } else {
    // Try to decode as bech32 (nsec)
    try {
      const decoded = nip19.decode(key);
      if (decoded.type === 'nsec') {
        // decoded.data for nsec is Uint8Array, convert to hex string
        const data = decoded.data;
        hexKey = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join('');
      } else {
        throw new Error('Key is not a valid nsec or hex private key');
      }
    } catch (error) {
      throw new Error(`Invalid key format: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Convert hex string to Uint8Array
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    keyBytes[i] = parseInt(hexKey.slice(i * 2, i * 2 + 2), 16);
  }
  return keyBytes;
}

/**
 * Get git config value
 */
function getGitConfig(key) {
  try {
    return execSync(`git config --get ${key}`, { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if this is a GitRepublic repository
 * Checks if any remote URL points to a GitRepublic server
 * GitRepublic URLs have the pattern: http://domain/repos/npub1.../repo-name
 * or http://domain/api/git/npub1.../repo-name.git
 */
function isGitRepublicRepo() {
  try {
    // Get all remotes
    const remotes = execSync('git remote -v', { encoding: 'utf-8' });
    const remoteLines = remotes.split('\n').filter(line => line.trim());
    
    // Check if any remote URL matches GitRepublic patterns
    // GitRepublic URLs use specific path patterns to distinguish from GRASP:
    // - http://localhost:5173/api/git/npub1.../repo-name.git (git operations via API)
    // - http://domain.com/repos/npub1.../repo-name (web UI endpoint)
    // - http://domain.com/npub1.../repo-name.git (direct, but conflicts with GRASP)
    // 
    // Note: We prioritize /api/git/ and /repos/ prefixes to avoid confusion with GRASP
    // which uses direct /npub/identifier.git pattern. If we only see /npub/ pattern
    // without these prefixes, we can't reliably distinguish from GRASP.
    for (const line of remoteLines) {
      const match = line.match(/^(?:fetch|push)\s+(https?:\/\/[^\s]+)/);
      if (match) {
        const remoteUrl = match[1];
        // Check for specific GitRepublic URL patterns (more specific than GRASP):
        // - /api/git/npub (GitRepublic API git endpoint - most reliable, unique to GitRepublic)
        // - /repos/npub (GitRepublic repos endpoint - unique to GitRepublic)
        // These patterns distinguish GitRepublic from GRASP which uses /npub/ directly
        if (remoteUrl.includes('/api/git/npub') || 
            remoteUrl.includes('/repos/npub')) {
          return true;
        }
        // Note: We don't check for direct /npub/ pattern here because it conflicts with GRASP
        // Users should use /api/git/ or /repos/ paths for GitRepublic to avoid ambiguity
      }
    }
    
    // Also check for .nostr-announcement file (GitRepublic marker)
    let gitDir = process.env.GIT_DIR;
    if (!gitDir) {
      // Try to find .git directory
      let currentDir = process.cwd();
      for (let i = 0; i < 10; i++) {
        const potentialGitDir = join(currentDir, '.git');
        if (existsSync(potentialGitDir)) {
          gitDir = potentialGitDir;
          break;
        }
        const parentDir = dirname(currentDir);
        if (parentDir === currentDir) break;
        currentDir = parentDir;
      }
    }
    
    if (gitDir) {
      const gitParent = resolve(gitDir, '..');
      const announcementFile = join(gitParent, '.nostr-announcement');
      if (existsSync(announcementFile)) {
        return true;
      }
    }
    
    // Also check current directory and parent directories
    let currentDir = process.cwd();
    for (let i = 0; i < 5; i++) {
      const announcementFile = join(currentDir, '.nostr-announcement');
      if (existsSync(announcementFile)) {
        return true;
      }
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
    
    return false;
  } catch {
    // If we can't determine, default to false (don't sign)
    return false;
  }
}

/**
 * Convert hex pubkey to shortened npub format
 */
function getShortenedNpub(hexPubkey) {
  try {
    // Convert hex string to Uint8Array
    const pubkeyBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      pubkeyBytes[i] = parseInt(hexPubkey.slice(i * 2, i * 2 + 2), 16);
    }
    
    // Encode to npub
    const npub = nip19.npubEncode(pubkeyBytes);
    
    // Return shortened version (first 16 characters: npub1 + 12 chars = 16 total)
    // This gives us a reasonable identifier while keeping it readable
    return npub.substring(0, 16);
  } catch (error) {
    // Fallback: use first 12 characters of hex pubkey
    return hexPubkey.substring(0, 12);
  }
}

/**
 * Create a commit signature event and append it to the commit message
 */
async function signCommitMessage(commitMessageFile) {
  // Check if NOSTRGIT_SECRET_KEY is set
  const secretKey = process.env.NOSTRGIT_SECRET_KEY;
  if (!secretKey) {
    // Allow unsigned commits, but inform user
    console.error('⚠️  NOSTRGIT_SECRET_KEY not set - commit will not be signed');
    console.error('   Set it with: export NOSTRGIT_SECRET_KEY="nsec1..."');
    return;
  }
  
  // Sign all commits by default - the signature is just text in the commit message
  // and doesn't interfere with git operations. It's useful to have consistent
  // signing across all repositories (GitHub, GitLab, GitRepublic, etc.)
  // 
  // To disable signing for non-GitRepublic repos, set GITREPUBLIC_SIGN_ONLY_GITREPUBLIC=true
  const isGitRepublic = isGitRepublicRepo();
  const signOnlyGitRepublic = process.env.GITREPUBLIC_SIGN_ONLY_GITREPUBLIC === 'true';
  
  if (!isGitRepublic && signOnlyGitRepublic) {
    // User explicitly wants to only sign GitRepublic repos
    return;
  }
  
  if (!isGitRepublic) {
    // Signing non-GitRepublic repo (GitHub, GitLab, etc.) - this is fine!
    // The signature is just metadata in the commit message
  }

  try {
    // Read the commit message
    const commitMessage = readFileSync(commitMessageFile, 'utf-8').trim();
    
    // Check if already signed (avoid double-signing)
    if (commitMessage.includes('Nostr-Signature:')) {
      console.log('ℹ️  Commit already signed, skipping');
      return;
    }

    // Decode the private key and get pubkey
    const keyBytes = decodeNostrKey(secretKey);
    const pubkey = getPublicKey(keyBytes);
    
    // Get author info from git config, fallback to shortened npub
    let authorName = getGitConfig('user.name');
    let authorEmail = getGitConfig('user.email');
    
    if (!authorName || !authorEmail) {
      const shortenedNpub = getShortenedNpub(pubkey);
      
      if (!authorName) {
        authorName = shortenedNpub;
      }
      
      if (!authorEmail) {
        authorEmail = `${shortenedNpub}@gitrepublic.web`;
      }
    }
    
    // Create timestamp
    const timestamp = Math.floor(Date.now() / 1000);
    
    // Create a commit signature event template
    // Note: We don't have the commit hash yet, so we'll sign without it
    // The signature is still valid as it signs the commit message
    const eventTemplate = {
      kind: KIND_COMMIT_SIGNATURE,
      pubkey,
      created_at: timestamp,
      tags: [
        ['author', authorName, authorEmail],
        ['message', commitMessage]
      ],
      content: `Signed commit: ${commitMessage}`
    };

    // Finalize and sign the event
    const signedEvent = finalizeEvent(eventTemplate, keyBytes);
    
    // Create a signature trailer that git can recognize
    // Format: Nostr-Signature: <event-id> <pubkey> <signature>
    // Note: The regex expects exactly 64 hex chars for event-id and pubkey, 128 for signature
    const signatureTrailer = `\n\nNostr-Signature: ${signedEvent.id} ${signedEvent.pubkey} ${signedEvent.sig}`;
    let signedMessage = commitMessage + signatureTrailer;
    
    // Store full event in nostr/ folder as JSONL (default behavior)
    try {
      // Find repository root (parent of .git directory)
      let repoRoot = null;
      let gitDir = process.env.GIT_DIR;
      if (!gitDir) {
        let currentDir = dirname(commitMessageFile);
        for (let i = 0; i < 10; i++) {
          const potentialGitDir = join(currentDir, '.git');
          if (existsSync(potentialGitDir)) {
            gitDir = potentialGitDir;
            repoRoot = currentDir;
            break;
          }
          const parentDir = dirname(currentDir);
          if (parentDir === currentDir) break;
          currentDir = parentDir;
        }
      } else {
        repoRoot = dirname(gitDir);
      }
      
      if (repoRoot) {
        // Store in nostr/ folder in repository root
        const nostrDir = join(repoRoot, 'nostr');
        if (!existsSync(nostrDir)) {
          execSync(`mkdir -p "${nostrDir}"`, { stdio: 'ignore' });
        }
        
        // Append to commit-signatures.jsonl (JSON Lines format)
        const jsonlFile = join(nostrDir, 'commit-signatures.jsonl');
        const eventLine = JSON.stringify(signedEvent) + '\n';
        writeFileSync(jsonlFile, eventLine, { flag: 'a', encoding: 'utf-8' });
      }
    } catch (storeError) {
      // Log but don't fail - storing event is nice-to-have
      console.error('   ⚠️  Failed to store event file:', storeError instanceof Error ? storeError.message : 'Unknown error');
    }
    
    // Optionally include full event JSON in commit message (base64 encoded)
    const includeFullEvent = process.env.GITREPUBLIC_INCLUDE_FULL_EVENT === 'true';
    if (includeFullEvent) {
      const eventJson = JSON.stringify(signedEvent);
      const eventBase64 = Buffer.from(eventJson, 'utf-8').toString('base64');
      signedMessage += `\nNostr-Event: ${eventBase64}`;
    }
    
    // Verify the signature format matches what the server expects
    const signatureRegex = /Nostr-Signature:\s+([0-9a-f]{64})\s+([0-9a-f]{64})\s+([0-9a-f]{128})/;
    if (!signatureRegex.test(signedMessage)) {
      throw new Error(`Generated signature format is invalid. Event ID: ${signedEvent.id.length} chars, Pubkey: ${signedEvent.pubkey.length} chars, Sig: ${signedEvent.sig.length} chars`);
    }
    
    // Write the signed message back to the file
    writeFileSync(commitMessageFile, signedMessage, 'utf-8');
    
    // Optionally publish event to Nostr relays
    const publishEvent = process.env.GITREPUBLIC_PUBLISH_EVENT === 'true';
    if (publishEvent) {
      try {
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
        
        const pool = new SimplePool();
        const results = await pool.publish(relays, signedEvent);
        pool.close(relays);
        
        const successCount = results.size;
        if (successCount > 0) {
          console.log(`   Published to ${successCount} relay(s)`);
        } else {
          console.log('   ⚠️  Failed to publish to relays');
        }
      } catch (publishError) {
        console.log(`   ⚠️  Failed to publish event: ${publishError instanceof Error ? publishError.message : 'Unknown error'}`);
      }
    }
    
    // Print success message
    const npub = getShortenedNpub(pubkey);
    console.log('✅ Commit signed with Nostr key');
    console.log(`   Pubkey: ${npub}...`);
    console.log(`   Event ID: ${signedEvent.id.substring(0, 16)}...`);
    console.log(`   Event stored in nostr/commit-signatures.jsonl`);
    if (includeFullEvent) {
      console.log('   Full event also included in commit message');
    }
  } catch (error) {
    // Log error
    console.error('❌ Failed to sign commit:', error instanceof Error ? error.message : 'Unknown error');
    if (error instanceof Error && error.stack && process.env.DEBUG) {
      console.error('Stack trace:', error.stack);
    }
    
    // Check if user wants to cancel on signing failure
    const cancelOnFailure = process.env.GITREPUBLIC_CANCEL_ON_SIGN_FAIL === 'true';
    
    if (cancelOnFailure) {
      console.error('   Commit cancelled due to signing failure (GITREPUBLIC_CANCEL_ON_SIGN_FAIL=true)');
      process.exit(1);
    } else {
      console.error('   Commit will proceed unsigned');
      // Exit with 0 to allow the commit to proceed even if signing fails
      process.exit(0);
    }
  }
}

// Main execution
const commitMessageFile = process.argv[2];
if (!commitMessageFile) {
  console.error('Usage: git-commit-msg-hook.js <commit-message-file>');
  process.exit(1);
}

signCommitMessage(commitMessageFile).catch((error) => {
  console.error('Fatal error in commit hook:', error);
  process.exit(1);
});
