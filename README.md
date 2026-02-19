# GitRepublic CLI

Command-line tools for GitRepublic: git wrapper with enhanced error messages, credential helper, commit signing hook, and API access.

> **Note**: This CLI is part of the `gitrepublic-web` monorepo but can also be used and published independently. See [SYNC.md](./SYNC.md) for information about syncing to a separate repository.

## Quick Start

```bash
# Install
npm install -g gitrepublic-cli

# Set your Nostr private key
export NOSTRGIT_SECRET_KEY="nsec1..."

# Setup (configures credential helper and commit hook)
gitrep-setup

# Use gitrepublic (or gitrep) as a drop-in replacement for git
gitrep clone https://your-domain.com/api/git/npub1.../repo.git gitrepublic-web
gitrep push gitrepublic-web main

# Note: "gitrep" is a shorter alias for "gitrepublic" - both work the same way.
# We suggest using "gitrepublic-web" as the remote name instead of "origin"
# because "origin" is often already set to GitHub, GitLab, or other services.
```

## Commands

- **`gitrepublic`** or **`gitrep`** - Git wrapper with enhanced error messages (use instead of `git`)
- **`gitrepublic-api`** or **`gitrep-api`** - Access GitRepublic APIs from command line
- **`gitrepublic-setup`** or **`gitrep-setup`** - Automatic setup script
- **`gitrepublic-uninstall`** or **`gitrep-uninstall`** - Remove all configuration

Run any command with `--help` or `-h` for detailed usage information.

## Uninstall

```bash
# Remove all configuration
gitrep-uninstall

# See what would be removed (dry run)
gitrep-uninstall --dry-run

# Keep environment variables
gitrep-uninstall --keep-env
```

## Features

- **Git Wrapper**: Enhanced error messages for GitRepublic operations
- **Credential Helper**: Automatic NIP-98 authentication
- **Commit Signing**: Automatically sign commits for GitRepublic repos
- **API Access**: Full command-line access to all GitRepublic APIs

## Requirements

- Node.js 18+
- Git
- Nostr private key (nsec format or hex)

## Commit Signing

The commit hook automatically signs **all commits** by default (GitHub, GitLab, GitRepublic, etc.). The signature is just text in the commit message and doesn't interfere with git operations.

To only sign GitRepublic repositories (skip GitHub/GitLab):

```bash
export GITREPUBLIC_SIGN_ONLY_GITREPUBLIC=true
```

To cancel commits if signing fails:

```bash
export GITREPUBLIC_CANCEL_ON_SIGN_FAIL=true
```

By default, the full event JSON is stored in `nostr/commit-signatures.jsonl` (JSON Lines format) for each signed commit. Events are organized by type in the `nostr/` folder for easy searching.

To also include the full event JSON in the commit message (base64 encoded):

```bash
export GITREPUBLIC_INCLUDE_FULL_EVENT=true
```

To publish commit signature events to Nostr relays:

```bash
export GITREPUBLIC_PUBLISH_EVENT=true
export NOSTR_RELAYS="wss://relay1.com,wss://relay2.com"  # Optional, has defaults
```

## Documentation

For detailed documentation, run:
- `gitrep --help` or `gitrepublic --help` - Git wrapper usage
- `gitrep-api --help` or `gitrepublic-api --help` - API commands
- `gitrep-setup --help` or `gitrepublic-setup --help` - Setup options
- `gitrep-uninstall --help` or `gitrepublic-uninstall --help` - Uninstall options

## Links

- [GitRepublic Web](https://github.com/silberengel/gitrepublic-web) - Full web application
- [NIP-98 Specification](https://github.com/nostr-protocol/nips/blob/master/98.md) - HTTP Authentication
- [Git Credential Helper Documentation](https://git-scm.com/docs/gitcredentials)

## License

MIT
