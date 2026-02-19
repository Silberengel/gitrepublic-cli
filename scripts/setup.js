#!/usr/bin/env node
/**
 * GitRepublic CLI Setup Script
 * 
 * Automatically configures git credential helper and commit signing hook
 * 
 * Usage:
 *   node scripts/setup.js [options]
 * 
 * Options:
 *   --credential-only    Only set up credential helper
 *   --hook-only          Only set up commit hook
 *   --domain <domain>    Configure credential helper for specific domain (default: all)
 *   --global-hook        Install hook globally for all repositories (default: current repo)
 */

import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync, mkdirSync, unlinkSync, symlinkSync } from 'fs';
import { spawnSync } from 'child_process';

// Get the directory where this script is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const scriptsDir = __dirname;

const credentialScript = join(scriptsDir, 'git-credential-nostr.js');
const commitHookScript = join(scriptsDir, 'git-commit-msg-hook.js');

// Show help
function showHelp() {
  console.log(`
GitRepublic CLI Setup

Automatically configures git credential helper and commit signing hook.

Usage:
  gitrep-setup [options] (or gitrepublic-setup)

Options:
  --credential-only          Only set up credential helper
  --hook-only                Only set up commit hook
  --domain <domain>          Configure credential helper for specific domain
  --global-hook              Install hook globally for all repositories
  --help, -h                 Show this help message

Examples:
  gitrep-setup                          # Setup both credential helper and hook
  gitrep-setup --domain your-domain.com # Configure for specific domain
  gitrep-setup --global-hook            # Install hook globally
  gitrep-setup --credential-only        # Only setup credential helper

The setup script will:
  - Automatically find the scripts (works with npm install or git clone)
  - Configure git credential helper
  - Install commit signing hook (current repo or globally)
  - Check if NOSTRGIT_SECRET_KEY is set

For multiple servers, run setup multiple times:
  gitrep-setup --domain server1.com --credential-only
  gitrep-setup --domain server2.com --credential-only

Documentation: https://github.com/silberengel/gitrepublic-cli
GitCitadel: Visit us on GitHub: https://github.com/ShadowySupercode or on our homepage: https://gitcitadel.com

GitRepublic CLI - Copyright (c) 2026 GitCitadel LLC
Licensed under MIT License
`);
}

// Parse command line arguments
const args = process.argv.slice(2);
const showHelpFlag = args.includes('--help') || args.includes('-h');
const credentialOnly = args.includes('--credential-only');
const hookOnly = args.includes('--hook-only');
const globalHook = args.includes('--global-hook');
const domainIndex = args.indexOf('--domain');
const domain = domainIndex >= 0 && args[domainIndex + 1] ? args[domainIndex + 1] : null;

if (showHelpFlag) {
  showHelp();
  process.exit(0);
}

// Check if scripts exist
if (!existsSync(credentialScript)) {
  console.error('Error: git-credential-nostr.js not found at', credentialScript);
  process.exit(1);
}

if (!existsSync(commitHookScript)) {
  console.error('Error: git-commit-msg-hook.js not found at', commitHookScript);
  process.exit(1);
}

// Check if NOSTRGIT_SECRET_KEY is set
const secretKey = process.env.NOSTRGIT_SECRET_KEY;
if (!secretKey) {
  console.warn('⚠️  Warning: NOSTRGIT_SECRET_KEY environment variable is not set.');
  console.warn('   Set it with: export NOSTRGIT_SECRET_KEY="nsec1..."');
  console.warn('   Or add to ~/.bashrc or ~/.zshrc for persistence\n');
}

// Setup credential helper
function setupCredentialHelper() {
  console.log('🔐 Setting up git credential helper...');
  
  try {
    let configCommand;
    
    // Security: Use spawnSync with argument arrays to prevent command injection
    if (domain) {
      // Configure for specific domain
      // Validate domain to prevent injection
      const protocol = domain.startsWith('https://') ? 'https' : domain.startsWith('http://') ? 'http' : 'https';
      const host = domain.replace(/^https?:\/\//, '').split('/')[0];
      // Validate host format (basic check)
      if (!/^[a-zA-Z0-9.-]+$/.test(host)) {
        throw new Error('Invalid domain format');
      }
      const configKey = `credential.${protocol}://${host}.helper`;
      const configValue = `!node ${credentialScript}`;
      spawnSync('git', ['config', '--global', configKey, configValue], { stdio: 'inherit' });
      console.log(`   Configuring for domain: ${host}`);
    } else {
      // Configure globally for all domains
      spawnSync('git', ['config', '--global', 'credential.helper', `!node ${credentialScript}`], { stdio: 'inherit' });
      console.log('   Configuring globally for all domains');
    }
    console.log('✅ Credential helper configured successfully!\n');
  } catch (error) {
    console.error('❌ Failed to configure credential helper:', error.message);
    process.exit(1);
  }
}

// Setup commit hook
function setupCommitHook() {
  console.log('✍️  Setting up commit signing hook...');
  
  try {
    if (globalHook) {
      // Install globally
      const hooksDir = resolve(process.env.HOME, '.git-hooks');
      
      // Create hooks directory if it doesn't exist
      // Security: Use fs.mkdirSync instead of execSync
      if (!existsSync(hooksDir)) {
        mkdirSync(hooksDir, { recursive: true });
      }
      
      // Create symlink
      const hookPath = join(hooksDir, 'commit-msg');
      if (existsSync(hookPath)) {
        console.log('   Removing existing hook...');
        unlinkSync(hookPath);
      }
      
      // Security: Use fs.symlinkSync instead of execSync
      symlinkSync(commitHookScript, hookPath);
      
      // Configure git to use global hooks
      // Note: Using ~/.git-hooks is safe as it's a literal string, not user input
      spawnSync('git', ['config', '--global', 'core.hooksPath', '~/.git-hooks'], { stdio: 'inherit' });
      
      console.log('✅ Commit hook installed globally for all repositories!\n');
    } else {
      // Install for current repository
      const gitDir = findGitDir();
      if (!gitDir) {
        console.error('❌ Error: Not in a git repository. Run this from a git repo or use --global-hook');
        process.exit(1);
      }
      
      const hookPath = join(gitDir, 'hooks', 'commit-msg');
      
      // Create hooks directory if it doesn't exist
      // Security: Use fs.mkdirSync instead of execSync
      const hooksDir = join(gitDir, 'hooks');
      if (!existsSync(hooksDir)) {
        mkdirSync(hooksDir, { recursive: true });
      }
      
      // Create symlink
      // Security: Use fs operations instead of execSync
      if (existsSync(hookPath)) {
        console.log('   Removing existing hook...');
        unlinkSync(hookPath);
      }
      
      symlinkSync(commitHookScript, hookPath);
      
      console.log('✅ Commit hook installed for current repository!\n');
    }
  } catch (error) {
    console.error('❌ Failed to setup commit hook:', error.message);
    process.exit(1);
  }
}

// Find .git directory
function findGitDir() {
  let currentDir = process.cwd();
  const maxDepth = 10;
  let depth = 0;
  
  while (depth < maxDepth) {
    const gitDir = join(currentDir, '.git');
    if (existsSync(gitDir)) {
      return gitDir;
    }
    
    const parentDir = resolve(currentDir, '..');
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
    depth++;
  }
  
  return null;
}

// Main execution
console.log('🚀 GitRepublic CLI Setup\n');
console.log('Scripts location:', scriptsDir);
console.log('Credential helper:', credentialScript);
console.log('Commit hook:', commitHookScript);
console.log('');

if (!credentialOnly && !hookOnly) {
  // Setup both
  setupCredentialHelper();
  setupCommitHook();
} else if (credentialOnly) {
  setupCredentialHelper();
} else if (hookOnly) {
  setupCommitHook();
}

console.log('✨ Setup complete!');
console.log('');
console.log('Next steps:');
if (!secretKey) {
  console.log('1. Set NOSTRGIT_SECRET_KEY: export NOSTRGIT_SECRET_KEY="nsec1..."');
}
console.log('2. Test credential helper: gitrep clone <gitrepublic-repo-url> gitrepublic-web');
console.log('3. Test commit signing: gitrep commit -m "Test commit"');

