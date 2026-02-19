# Syncing CLI to Separate Repository

This document explains how to keep the `gitrepublic-cli` in sync with a separate repository while maintaining it as part of the `gitrepublic-web` monorepo.

## When to Sync

You should sync the CLI to a separate repository when:

### 1. **Publishing to npm**
   - Before publishing a new version to npm, sync to ensure the separate repo is up-to-date
   - This allows users to install via `npm install -g gitrepublic-cli` from the published package
   - The separate repo serves as the source of truth for npm package releases

### 2. **Independent Development & Contributions**
   - When you want others to contribute to the CLI without needing access to the full web repo
   - Allows CLI-specific issues, discussions, and pull requests
   - Makes the CLI more discoverable as a standalone project

### 3. **Separate Release Cycle**
   - If you want to version and release the CLI independently from the web application
   - Allows different release cadences (e.g., CLI updates more frequently than the web app)
   - Enables CLI-specific changelogs and release notes

### 4. **CI/CD & Automation**
   - If you want separate CI/CD pipelines for the CLI (testing, linting, publishing)
   - Allows automated npm publishing on version bumps
   - Can set up separate GitHub Actions workflows for CLI-specific tasks

### 5. **Documentation & Discoverability**
   - Makes the CLI easier to find for users who only need the CLI tools
   - Allows separate documentation site or GitHub Pages
   - Better SEO and discoverability on GitHub/npm

## When NOT to Sync

You typically don't need to sync if:
- You're only developing internally and not publishing to npm
- The CLI is tightly coupled to the web app and changes together
- You prefer keeping everything in one repository for simplicity

## Recommended Workflow

1. **Develop in monorepo**: Make all changes in `gitrepublic-cli/` within the main repo
2. **Sync before publishing**: Run `npm run cli:sync` before publishing to npm
3. **Publish from separate repo**: Publish to npm from the synced repository (or use CI/CD)
4. **Keep in sync**: Sync regularly to ensure the separate repo stays current

## Option 1: Git Subtree (Recommended)

Git subtree allows you to maintain the CLI as part of this repo while also syncing it to a separate repository.

### Initial Setup (One-time)

1. **Add the separate repo as a remote:**
   ```bash
   cd /path/to/gitrepublic-web
   git remote add cli-repo https://github.com/silberengel/gitrepublic-cli.git
   ```

2. **Push the CLI directory to the separate repo:**
   ```bash
   git subtree push --prefix=gitrepublic-cli cli-repo main
   ```

### Syncing Changes

**To push changes from monorepo to separate repo:**
```bash
git subtree push --prefix=gitrepublic-cli cli-repo main
```

**To pull changes from separate repo to monorepo:**
```bash
git subtree pull --prefix=gitrepublic-cli cli-repo main --squash
```

### Publishing to npm

From the separate repository:
```bash
cd /path/to/gitrepublic-cli
npm publish
```

## Option 2: Manual Sync Script

A script is provided to help sync changes:

```bash
./scripts/sync-cli.sh
```

This script:
1. Copies changes from `gitrepublic-cli/` to a separate repo directory
2. Commits and pushes to the separate repo
3. Can be run after making CLI changes

## Option 3: GitHub Actions / CI

You can set up automated syncing using GitHub Actions. See `.github/workflows/sync-cli.yml` (if created).

## Publishing

The CLI can be published independently from npm:

```bash
cd gitrepublic-cli
npm version patch  # or minor, major
npm publish
```

The CLI's `package.json` is configured to publish only the necessary files (scripts, README, LICENSE).
