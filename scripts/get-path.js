#!/usr/bin/env node
/**
 * Helper script to get the installation path of GitRepublic CLI scripts
 * Useful for configuring git credential helpers and hooks
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

// Get the directory where this script is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptsDir = __dirname;

// Check if scripts exist
const credentialScript = join(scriptsDir, 'git-credential-nostr.js');
const commitHookScript = join(scriptsDir, 'git-commit-msg-hook.js');

if (process.argv[2] === '--credential' || process.argv[2] === '-c') {
  if (existsSync(credentialScript)) {
    console.log(credentialScript);
  } else {
    console.error('Error: git-credential-nostr.js not found');
    process.exit(1);
  }
} else if (process.argv[2] === '--hook' || process.argv[2] === '-h') {
  if (existsSync(commitHookScript)) {
    console.log(commitHookScript);
  } else {
    console.error('Error: git-commit-msg-hook.js not found');
    process.exit(1);
  }
} else {
  // Default: show both paths
  console.log('GitRepublic CLI Scripts:');
  console.log('Credential Helper:', credentialScript);
  console.log('Commit Hook:', commitHookScript);
  console.log('');
  console.log('Usage:');
  console.log('  node get-path.js --credential  # Get credential helper path');
  console.log('  node get-path.js --hook        # Get commit hook path');
}
