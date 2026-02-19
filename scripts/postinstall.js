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

  3. Use gitrep (or gitrepublic) as a drop-in replacement for git:
     gitrep clone https://your-domain.com/api/git/npub1.../repo.git gitrepublic-web
     gitrep push gitrepublic-web main
     
     Note: "gitrep" is a shorter alias for "gitrepublic" - both work the same way.
     Use "gitrepublic-web" as the remote name (not "origin") since
     "origin" is often already set to GitHub, GitLab, or other services.

Commands:
  gitrepublic / gitrep              Git wrapper with enhanced error messages
  gitrepublic-api / gitrep-api      Access GitRepublic APIs
  gitrepublic-setup / gitrep-setup  Configure git credential helper and commit hook
  gitrepublic-uninstall / gitrep-uninstall  Remove all configuration

Get Help:
  gitrep --help (or gitrepublic --help)
  gitrep-api --help (or gitrepublic-api --help)
  gitrep-setup --help (or gitrepublic-setup --help)

Documentation: https://github.com/silberengel/gitrepublic-cli
GitCitadel: Visit us on GitHub: https://github.com/ShadowySupercode or on our homepage: https://gitcitadel.com

GitRepublic CLI - Copyright (c) 2026 GitCitadel LLC
Licensed under MIT License
`);
