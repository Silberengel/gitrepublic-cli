#!/usr/bin/env node
/**
 * Post-install script - Shows welcome message and next steps
 */

console.log(`
╔══════════════════════════════════════════════════════════════╗
║           GitRepublic CLI - Installation Complete            ║
╚══════════════════════════════════════════════════════════════╝

Quick Start:
  1. Set your Nostr private key:
     export NOSTRGIT_SECRET_KEY="nsec1..."

  2. Run setup to configure git:
     gitrep-setup

  3. Use gitrep (or gitrepublic) for all commands:
     # Git operations
     gitrep clone https://your-domain.com/api/git/npub1.../repo.git gitrepublic-web
     gitrep push gitrepublic-web main
     
     # API commands
     gitrep push-all main              # Push to all remotes
     gitrep repos list                 # List repositories
     gitrep publish repo-announcement myrepo
     
     Note: "gitrep" is a shorter alias for "gitrepublic" - both work the same way.
     Use "gitrepublic-web" as the remote name (not "origin") since
     "origin" is often already set to GitHub, GitLab, or other services.

Commands:
  gitrepublic / gitrep              Unified command for git and API operations
  gitrepublic-api / gitrep-api      (Alias to gitrep/gitrepublic for backward compatibility)
  gitrepublic-setup / gitrep-setup  Configure git credential helper and commit hook
  gitrepublic-uninstall / gitrep-uninstall  Remove all configuration

Get Help:
  gitrep --help                      General help and git commands
  gitrep push-all --help             Push to all remotes
  gitrep repos --help                Repository management
  gitrep publish --help              Publish Nostr events
  gitrep-setup --help                Setup options

Documentation: https://github.com/silberengel/gitrepublic-cli
GitCitadel: Visit us on GitHub: https://github.com/ShadowySupercode or on our homepage: https://gitcitadel.com

GitRepublic CLI - Copyright (c) 2026 GitCitadel LLC
Licensed under MIT License
`);
