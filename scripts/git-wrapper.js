#!/usr/bin/env node
/**
 * Git wrapper that provides detailed error messages for GitRepublic operations
 * 
 * This script wraps git commands and provides helpful error messages when
 * operations fail, especially for authentication and permission errors.
 * 
 * Usage:
 *   gitrepublic <git-command> [arguments...]
 *   gitrep <git-command> [arguments...]  (shorter alias)
 * 
 * Examples:
 *   gitrep clone https://domain.com/api/git/npub1.../repo.git gitrepublic-web
 *   gitrep push gitrepublic-web main
 *   gitrep pull gitrepublic-web main
 *   gitrep fetch gitrepublic-web
 */

import { spawn, execSync } from 'child_process';
import { createHash } from 'crypto';
import { finalizeEvent } from 'nostr-tools';
import { decode } from 'nostr-tools/nip19';

// NIP-98 auth event kind
const KIND_NIP98_AUTH = 27235;

// Commands that interact with remotes (need error handling)
const REMOTE_COMMANDS = ['clone', 'push', 'pull', 'fetch', 'ls-remote'];

// Get git remote URL
function getRemoteUrl(remote = 'origin') {
  try {
    const url = execSync(`git config --get remote.${remote}.url`, { encoding: 'utf-8' }).trim();
    return url;
  } catch {
    return null;
  }
}

// Extract server URL and repo path from git remote URL
function parseGitUrl(url) {
  // Match patterns like:
  // http://localhost:5173/api/git/npub1.../repo.git
  // https://domain.com/api/git/npub1.../repo.git
  // http://localhost:5173/repos/npub1.../repo.git
  const match = url.match(/^(https?:\/\/[^\/]+)(\/api\/git\/|\/repos\/)(.+)$/);
  if (match) {
    return {
      server: match[1],
      path: match[3]
    };
  }
  return null;
}

// Check if URL is a GitRepublic repository
function isGitRepublicUrl(url) {
  return url && (url.includes('/api/git/') || url.includes('/repos/'));
}

// Get NOSTRGIT_SECRET_KEY from environment
function getSecretKey() {
  return process.env.NOSTRGIT_SECRET_KEY || null;
}

// Create NIP-98 authentication event
function createNIP98Auth(url, method, body = null) {
  const secretKey = getSecretKey();
  if (!secretKey) {
    return null;
  }

  try {
    // Decode secret key (handle both nsec and hex formats)
    let hexKey;
    if (secretKey.startsWith('nsec')) {
      const decoded = decode(secretKey);
      hexKey = decoded.data;
    } else {
      hexKey = secretKey;
    }

    // Create auth event
    const tags = [
      ['u', url],
      ['method', method]
    ];

    if (body) {
      const hash = createHash('sha256').update(body).digest('hex');
      tags.push(['payload', hash]);
    }

    const event = finalizeEvent({
      kind: KIND_NIP98_AUTH,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: ''
    }, hexKey);

    // Encode event as base64
    const eventJson = JSON.stringify(event);
    return Buffer.from(eventJson).toString('base64');
  } catch (err) {
    return null;
  }
}

// Fetch error message from server
async function fetchErrorMessage(server, path, method = 'POST') {
  try {
    const url = `${server}/api/git/${path}/git-receive-pack`;
    const authEvent = createNIP98Auth(url, method);
    
    if (!authEvent) {
      return null;
    }

    // Create Basic auth header (username=nostr, password=base64-event)
    const authHeader = Buffer.from(`nostr:${authEvent}`).toString('base64');
    
    // Use Node's fetch API (available in Node 18+)
    try {
      const response = await fetch(url, {
        method: method,
        headers: {
          'Authorization': `Basic ${authHeader}`,
          'Content-Type': method === 'POST' ? 'application/x-git-receive-pack-request' : 'application/json',
          'Content-Length': '0'
        }
      });

      if (response.status === 403 || response.status === 401) {
        const text = await response.text();
        return { status: response.status, message: text || null };
      }
      
      return null;
    } catch (fetchErr) {
      // Fallback: if fetch is not available, use http module
      const { request } = await import('http');
      const { request: httpsRequest } = await import('https');
      const httpModule = url.startsWith('https:') ? httpsRequest : request;
      const urlObj = new URL(url);
      
      return new Promise((resolve) => {
        const req = httpModule({
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path: urlObj.pathname,
          method: method,
          headers: {
            'Authorization': `Basic ${authHeader}`,
            'Content-Type': method === 'POST' ? 'application/x-git-receive-pack-request' : 'application/json',
            'Content-Length': '0'
          }
        }, (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk.toString();
          });
          res.on('end', () => {
            if ((res.statusCode === 403 || res.statusCode === 401) && body) {
              resolve({ status: res.statusCode, message: body });
            } else {
              resolve(null);
            }
          });
        });

        req.on('error', () => {
          resolve(null);
        });

        req.end();
      });
    }
  } catch (err) {
    return null;
  }
}

// Format error message for display
function formatErrorMessage(errorInfo, command, args) {
  if (!errorInfo || !errorInfo.message) {
    return null;
  }

  const lines = [
    '',
    '='.repeat(70),
    `GitRepublic Error Details (${command})`,
    '='.repeat(70),
    '',
    errorInfo.message,
    '',
    '='.repeat(70),
    ''
  ];

  return lines.join('\n');
}

// Run git command and capture output
function runGitCommand(command, args) {
  return new Promise((resolve) => {
    const gitProcess = spawn('git', [command, ...args], {
      stdio: ['inherit', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    gitProcess.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(chunk);
    });

    gitProcess.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(chunk);
    });

    gitProcess.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    gitProcess.on('error', (err) => {
      resolve({ code: 1, stdout, stderr, error: err });
    });
  });
}

// Show help
function showHelp() {
  console.log(`
GitRepublic Git Wrapper

A drop-in replacement for git that provides enhanced error messages for GitRepublic operations.

Usage:
  gitrepublic <git-command> [arguments...]
  gitrep <git-command> [arguments...]  (shorter alias)

Examples:
  gitrep clone https://domain.com/api/git/npub1.../repo.git gitrepublic-web
  gitrep push gitrepublic-web main
  gitrep pull gitrepublic-web main
  gitrep fetch gitrepublic-web
  gitrep branch
  gitrep commit -m "My commit"

Note: "gitrep" is a shorter alias for "gitrepublic" - both work the same way.
We suggest using "gitrepublic-web" as the remote name instead of "origin"
because "origin" is often already set to GitHub, GitLab, or other services.

Features:
  - Works with all git commands (clone, push, pull, fetch, branch, merge, etc.)
  - Enhanced error messages for GitRepublic repositories
  - Detailed authentication and permission error information
  - Transparent pass-through for non-GitRepublic repositories (GitHub, GitLab, etc.)

For GitRepublic repositories, the wrapper provides:
  - Detailed 401/403 error messages with pubkeys and maintainer information
  - Helpful guidance on how to fix authentication issues
  - Automatic fetching of error details from the server

Documentation: https://github.com/silberengel/gitrepublic-cli
GitCitadel: Visit us on GitHub: https://github.com/ShadowySupercode or on our homepage: https://gitcitadel.com

GitRepublic CLI - Copyright (c) 2026 GitCitadel LLC
Licensed under MIT License
`);
}

// Main function
async function main() {
  const args = process.argv.slice(2);
  
  // Check for help flag
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  // For clone, check if URL is GitRepublic
  if (command === 'clone' && commandArgs.length > 0) {
    const url = commandArgs[commandArgs.length - 1];
    if (!isGitRepublicUrl(url)) {
      // Not a GitRepublic URL, just run git normally
      const result = await runGitCommand(command, commandArgs);
      process.exit(result.code || 0);
      return;
    }
  }

  // For non-remote commands (branch, merge, commit, etc.), just pass through
  // These don't interact with remotes, so no special error handling needed
  if (!REMOTE_COMMANDS.includes(command)) {
    const result = await runGitCommand(command, commandArgs);
    process.exit(result.code || 0);
    return;
  }

  // Run git command (for remote commands)
  const result = await runGitCommand(command, commandArgs);

  // If command failed and it's a remote command, try to get detailed error
  // But only if it's a GitRepublic repository
  if (result.code !== 0 && REMOTE_COMMANDS.includes(command)) {
    const hasAuthError = result.stderr.includes('401') || 
                        result.stderr.includes('403') ||
                        result.stdout.includes('401') ||
                        result.stdout.includes('403');

    if (hasAuthError) {
      let remoteUrl = null;
      let parsed = null;

      // For clone, get URL from arguments
      if (command === 'clone' && commandArgs.length > 0) {
        remoteUrl = commandArgs[commandArgs.length - 1];
        parsed = parseGitUrl(remoteUrl);
      } else {
        // For other commands (push, pull, fetch), try to get remote name from args first
        // Commands like "push gitrepublic-web main" or "push -u gitrepublic-web main"
        let remoteName = 'origin'; // Default
        for (let i = 0; i < commandArgs.length; i++) {
          const arg = commandArgs[i];
          // Skip flags like -u, --set-upstream, etc.
          if (arg.startsWith('-')) {
            continue;
          }
          // If it doesn't look like a branch/ref (no /, not a commit hash), it might be a remote
          if (!arg.includes('/') && !/^[0-9a-f]{7,40}$/.test(arg)) {
            remoteName = arg;
            break;
          }
        }
        
        // Try the specified remote, then fall back to 'origin', then 'gitrepublic-web'
        remoteUrl = getRemoteUrl(remoteName);
        if (!remoteUrl && remoteName !== 'origin') {
          remoteUrl = getRemoteUrl('origin');
        }
        if (!remoteUrl) {
          remoteUrl = getRemoteUrl('gitrepublic-web');
        }
        
        if (remoteUrl && isGitRepublicUrl(remoteUrl)) {
          parsed = parseGitUrl(remoteUrl);
        }
      }

      // Only try to fetch detailed errors for GitRepublic repositories
      if (parsed) {
        // Try to fetch detailed error message
        const errorInfo = await fetchErrorMessage(parsed.server, parsed.path, command === 'push' ? 'POST' : 'GET');
        
        if (errorInfo && errorInfo.message) {
          const formattedError = formatErrorMessage(errorInfo, command, commandArgs);
          if (formattedError) {
            console.error(formattedError);
          }
        } else {
          // Provide helpful guidance even if we can't fetch the error
          console.error('');
          console.error('='.repeat(70));
          console.error(`GitRepublic ${command} failed`);
          console.error('='.repeat(70));
          console.error('');
          
          if (result.stderr.includes('401') || result.stdout.includes('401')) {
            console.error('Authentication failed. Please check:');
            console.error('  1. NOSTRGIT_SECRET_KEY is set correctly');
            console.error('  2. Your private key (nsec) matches the repository owner or maintainer');
            console.error('  3. The credential helper is configured: gitrep-setup (or gitrepublic-setup)');
          } else if (result.stderr.includes('403') || result.stdout.includes('403')) {
            console.error('Permission denied. Please check:');
            console.error('  1. You are using the correct private key (nsec)');
            console.error('  2. You are the repository owner or have been added as a maintainer');
          }
          
          console.error('');
          console.error('For more help, see: https://github.com/silberengel/gitrepublic-cli');
          console.error('='.repeat(70));
          console.error('');
        }
      }
    }
  }

  process.exit(result.code || 0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
