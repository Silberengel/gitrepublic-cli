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
 */

import { DEFAULT_SERVER } from './config.js';
import { sanitizeErrorMessage } from './utils/error-sanitizer.js';
import * as commands from './commands/index.js';

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

// Handle config command
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
    const errorMessage = error instanceof Error ? error.message : String(error);
    const sanitized = sanitizeErrorMessage(errorMessage);
    console.error('Error:', sanitized);
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
  const errorMessage = error instanceof Error ? error.message : String(error);
  const sanitized = sanitizeErrorMessage(errorMessage);
  console.error('Error:', sanitized);
  process.exit(1);
});
