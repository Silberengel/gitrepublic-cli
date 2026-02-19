#!/usr/bin/env node
/**
 * GitRepublic CLI Uninstall Script
 * 
 * Removes all GitRepublic CLI configuration from your system
 */

import { spawnSync } from 'child_process';
import { existsSync, unlinkSync, rmdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function showHelp() {
  console.log(`
GitRepublic CLI Uninstall

This script removes:
  - Git credential helper configuration
  - Commit signing hook (local and global)
  - Environment variable references (from shell config files)

Usage:
  gitrep-uninstall [options] (or gitrepublic-uninstall)

Options:
  --help, -h          Show this help message
  --dry-run, -d       Show what would be removed without actually removing it
  --keep-env          Don't remove environment variable exports from shell config

Examples:
  gitrep-uninstall              # Full uninstall
  gitrep-uninstall --dry-run    # See what would be removed
  gitrep-uninstall --keep-env   # Keep environment variables

Documentation: https://github.com/silberengel/gitrepublic-cli
GitCitadel: Visit us on GitHub: https://github.com/ShadowySupercode or on our homepage: https://gitcitadel.com

GitRepublic CLI - Copyright (c) 2026 GitCitadel LLC
Licensed under MIT License
`);
}

function getShellConfigFile() {
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh')) {
    return join(homedir(), '.zshrc');
  } else if (shell.includes('fish')) {
    return join(homedir(), '.config', 'fish', 'config.fish');
  } else {
    return join(homedir(), '.bashrc');
  }
}

function removeFromShellConfig(pattern, dryRun) {
  const configFile = getShellConfigFile();
  if (!existsSync(configFile)) {
    return false;
  }

  try {
    const content = readFileSync(configFile, 'utf-8');
    const lines = content.split('\n');
    const filtered = lines.filter(line => !line.includes(pattern));
    
    if (filtered.length !== lines.length) {
      if (!dryRun) {
        writeFileSync(configFile, filtered.join('\n'), 'utf-8');
      }
      return true;
    }
  } catch (err) {
    // Ignore errors
  }
  return false;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('-d');
  const keepEnv = args.includes('--keep-env');
  const showHelpFlag = args.includes('--help') || args.includes('-h');

  if (showHelpFlag) {
    showHelp();
    process.exit(0);
  }

  console.log('GitRepublic CLI Uninstall\n');

  if (dryRun) {
    console.log('DRY RUN MODE - No changes will be made\n');
  }

  let removed = 0;

  // Remove credential helper configurations
  console.log('Removing git credential helper configurations...');
  try {
    // Security: Use spawnSync with argument arrays
    const result = spawnSync('git', ['config', '--global', '--get-regexp', 'credential.*helper'], { encoding: 'utf-8' });
    if (result.status === 0) {
      const credentialConfigs = result.stdout
        .split('\n')
        .filter(line => line.trim() && (line.includes('gitrepublic') || line.includes('git-credential-nostr')));
      
      for (const config of credentialConfigs) {
        if (config.trim()) {
          const key = config.split(' ')[0];
          if (key) {
            console.log(`  - ${key}`);
            if (!dryRun) {
              try {
                // Security: Use spawnSync with argument arrays
                spawnSync('git', ['config', '--global', '--unset', key], { stdio: 'ignore' });
              } catch {
                // Ignore if already removed
              }
            }
            removed++;
          }
        }
      }
    }
  } catch {
    // No credential helpers configured
  }

  // Remove commit hook (global)
  console.log('\nRemoving global commit hook...');
  try {
    // Security: Use spawnSync with argument arrays
    const result = spawnSync('git', ['config', '--global', '--get', 'core.hooksPath'], { encoding: 'utf-8' });
    const hooksPath = result.status === 0 ? result.stdout.trim() : null;
    if (hooksPath) {
      const hookFile = join(hooksPath, 'commit-msg');
      if (existsSync(hookFile)) {
        console.log(`  - ${hookFile}`);
        if (!dryRun) {
          try {
            unlinkSync(hookFile);
            // Try to remove directory if empty
            try {
              rmdirSync(hooksPath);
            } catch {
              // Directory not empty, that's fine
            }
          } catch (err) {
            console.error(`    Warning: Could not remove ${hookFile}: ${err.message}`);
          }
        }
        removed++;
      }
    }
    
    // Remove core.hooksPath config
    try {
      // Security: Use spawnSync with argument arrays
      spawnSync('git', ['config', '--global', '--unset', 'core.hooksPath'], { stdio: 'ignore' });
      if (!dryRun) {
        console.log('  - Removed core.hooksPath configuration');
      }
    } catch {
      // Already removed
    }
  } catch {
    // No global hook configured
  }

  // Remove commit hook from current directory
  console.log('\nChecking current directory for commit hook...');
  const localHook = '.git/hooks/commit-msg';
  if (existsSync(localHook)) {
    try {
      const hookContent = readFileSync(localHook, 'utf-8');
      if (hookContent.includes('gitrepublic') || hookContent.includes('git-commit-msg-hook')) {
        console.log(`  - ${localHook}`);
        if (!dryRun) {
          unlinkSync(localHook);
        }
        removed++;
      }
    } catch {
      // Ignore errors
    }
  }

  // Remove environment variables from shell config
  if (!keepEnv) {
    console.log('\nRemoving environment variables from shell config...');
    const configFile = getShellConfigFile();
    const patterns = ['NOSTRGIT_SECRET_KEY', 'GITREPUBLIC_SERVER'];
    
    for (const pattern of patterns) {
      if (removeFromShellConfig(pattern, dryRun)) {
        console.log(`  - Removed ${pattern} from ${configFile}`);
        removed++;
      }
    }
  }

  console.log(`\n${dryRun ? 'Would remove' : 'Removed'} ${removed} configuration item(s).`);
  
  if (!dryRun) {
    console.log('\n✅ Uninstall complete!');
    console.log('\nNote: Environment variables in your current shell session are still set.');
    console.log('Start a new shell session to clear them, or run:');
    console.log('  unset NOSTRGIT_SECRET_KEY');
    console.log('  unset GITREPUBLIC_SERVER');
  } else {
    console.log('\nRun without --dry-run to actually remove these items.');
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
