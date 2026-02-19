import { getPrivateKeyFromEnv, getPrivateKeyBytes } from '../../utils/keys.js';
import { getPublicKey } from 'nostr-tools';
import { DEFAULT_RELAYS } from '../../config.js';
import { publishToRelays } from '../../relay/publisher.js';
import { enhanceRelayList } from '../../relay/relay-fetcher.js';
import { storeEventInJsonl } from '../../utils/event-storage.js';
import { addClientTag } from '../../utils/tags.js';

// Import publish subcommands
import { publishRepoAnnouncement } from './repo-announcement.js';
import { publishOwnershipTransfer } from './ownership-transfer.js';
import { publishPR } from './pr.js';
import { publishIssue } from './issue.js';
import { publishStatus } from './status.js';
import { publishPatch } from './patch.js';
import { publishRepoState } from './repo-state.js';
import { publishPRUpdate } from './pr-update.js';
import { publishEvent } from './event.js';

/**
 * Main publish command handler
 */
export async function publish(args, server, json) {
  const subcommand = args[0];
  
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    showPublishHelp();
    process.exit(0);
  }

  // Get private key
  const secretKey = getPrivateKeyFromEnv();
  const privateKeyBytes = getPrivateKeyBytes(secretKey);
  const pubkey = getPublicKey(privateKeyBytes);

  // Get relays from environment or use defaults
  const relaysEnv = process.env.NOSTR_RELAYS;
  const baseRelays = relaysEnv ? relaysEnv.split(',').map(r => r.trim()).filter(r => r.length > 0) : DEFAULT_RELAYS;
  
  // Enhance relay list with user's relay preferences (outboxes, local relays, blocked relays)
  const relays = await enhanceRelayList(baseRelays, pubkey, baseRelays);

  // Route to appropriate subcommand
  try {
    switch (subcommand) {
      case 'repo-announcement':
        await publishRepoAnnouncement(args.slice(1), relays, privateKeyBytes, pubkey, json);
        break;
      case 'ownership-transfer':
        await publishOwnershipTransfer(args.slice(1), relays, privateKeyBytes, pubkey, json);
        break;
      case 'pr':
      case 'pull-request':
        await publishPR(args.slice(1), relays, privateKeyBytes, pubkey, json);
        break;
      case 'issue':
        await publishIssue(args.slice(1), relays, privateKeyBytes, pubkey, json);
        break;
      case 'status':
        await publishStatus(args.slice(1), relays, privateKeyBytes, pubkey, json);
        break;
      case 'patch':
        await publishPatch(args.slice(1), relays, privateKeyBytes, pubkey, json);
        break;
      case 'repo-state':
        await publishRepoState(args.slice(1), relays, privateKeyBytes, pubkey, json);
        break;
      case 'pr-update':
      case 'pull-request-update':
        await publishPRUpdate(args.slice(1), relays, privateKeyBytes, pubkey, json);
        break;
      case 'event':
        await publishEvent(args.slice(1), relays, privateKeyBytes, pubkey, json);
        break;
      default:
        console.error(`Error: Unknown publish subcommand: ${subcommand}`);
        console.error('Use: publish repo-announcement|ownership-transfer|pr|pr-update|issue|status|patch|repo-state|event');
        console.error('Run: publish --help for detailed usage');
        process.exit(1);
    }
  } catch (error) {
    const { sanitizeErrorMessage } = await import('../../utils/error-sanitizer.js');
    const errorMessage = error instanceof Error ? error.message : String(error);
    const sanitized = sanitizeErrorMessage(errorMessage);
    console.error('Error:', sanitized);
    process.exit(1);
  }
}

/**
 * Common publish function that handles event creation, storage, and publishing
 */
export async function publishEventCommon(event, relays, privateKeyBytes, pubkey, json, eventType = 'Event') {
  // Store event in JSONL file
  storeEventInJsonl(event);
  
  const result = await publishToRelays(event, relays, privateKeyBytes, pubkey);
  
  if (json) {
    console.log(JSON.stringify({ event, published: result }, null, 2));
  } else {
    console.log(`${eventType} published!`);
    console.log(`Event ID: ${event.id}`);
    console.log(`Event stored in nostr/${getEventStorageFile(event.kind)}`);
    console.log(`Published to ${result.success.length} relay(s): ${result.success.join(', ')}`);
    if (result.failed.length > 0) {
      console.log(`Failed on ${result.failed.length} relay(s):`);
      result.failed.forEach(f => console.log(`  ${f.relay}: ${f.error}`));
    }
  }
  
  return result;
}

/**
 * Get storage file name for event kind
 */
function getEventStorageFile(kind) {
  switch (kind) {
    case 30617: return 'repo-announcements.jsonl';
    case 1641: return 'ownership-transfers.jsonl';
    case 1617: return 'patches.jsonl';
    case 1618: return 'pull-requests.jsonl';
    case 1619: return 'pull-request-updates.jsonl';
    case 1621: return 'issues.jsonl';
    case 1630:
    case 1631:
    case 1632:
    case 1633: return 'status-events.jsonl';
    case 30618: return 'repo-states.jsonl';
    default: return `events-kind-${kind}.jsonl`;
  }
}

function showPublishHelp() {
  console.log(`
Publish Nostr Git Events

Usage: gitrep publish <subcommand> [options]

Subcommands:
  repo-announcement <repo-name> [options]
    Publish a repository announcement (kind 30617)
    Options:
      --description <text>        Repository description
      --clone-url <url>          Clone URL (can be specified multiple times)
      --web-url <url>            Web URL (can be specified multiple times)
      --maintainer <npub>        Maintainer pubkey (can be specified multiple times)
      --relay <url>              Custom relay URL (can be specified multiple times)
    
    Example:
      gitrep publish repo-announcement myrepo \\
        --description "My awesome repo" \\
        --clone-url "https://gitrepublic.com/api/git/npub1.../myrepo.git" \\
        --maintainer "npub1..."

  ownership-transfer <repo> <new-owner-npub> [--self-transfer]
    Transfer repository ownership (kind 1641)
    Note: You must be the current owner (signing with NOSTRGIT_SECRET_KEY)
    
    Example:
      gitrep publish ownership-transfer myrepo npub1... --self-transfer

  pr <owner-npub> <repo> <title> [options]
    Create a pull request (kind 1618)
    Options:
      --content <text>           PR description/content
      --base <branch>           Base branch (default: main)
      --head <branch>           Head branch (default: main)
    
    Example:
      gitrep publish pr npub1... myrepo "Fix bug" \\
        --content "This PR fixes a critical bug" \\
        --base main --head feature-branch

  issue <owner-npub> <repo> <title> [options]
    Create an issue (kind 1621)
    Options:
      --content <text>           Issue description
      --label <label>            Label (can be specified multiple times)
    
    Example:
      gitrep publish issue npub1... myrepo "Bug report" \\
        --content "Found a bug" --label bug --label critical

  status <event-id> <open|applied|closed|draft> [--content <text>]
    Update PR/issue status (kinds 1630-1633)
    
    Example:
      gitrep publish status abc123... closed --content "Fixed in v1.0"

  patch <owner-npub> <repo> <patch-file> [options]
    Publish a git patch (kind 1617)
    Options:
      --earliest-commit <id>    Earliest unique commit ID (euc)
      --commit <id>             Current commit ID
      --parent-commit <id>      Parent commit ID
      --root                    Mark as root patch
      --root-revision           Mark as root revision
      --reply-to <event-id>     Reply to previous patch (NIP-10)
      --mention <npub>         Mention user (can be specified multiple times)
    
    Example:
      gitrep publish patch npub1... myrepo patch-0001.patch \\
        --earliest-commit abc123 --commit def456 --root

  repo-state <repo> [options]
    Publish repository state (kind 30618)
    Options:
      --ref <ref-path> <commit-id> [parent-commits...]  Add ref (can be specified multiple times)
      --head <branch>                                   Set HEAD branch
    
    Example:
      gitrep publish repo-state myrepo \\
        --ref refs/heads/main abc123 def456 \\
        --ref refs/tags/v1.0.0 xyz789 \\
        --head main

  pr-update <owner-npub> <repo> <pr-event-id> <commit-id> [options]
    Update pull request tip commit (kind 1619)
    Options:
      --pr-author <npub>       PR author pubkey (for NIP-22 tags)
      --clone-url <url>        Clone URL (required, can be specified multiple times)
      --merge-base <commit-id>  Most recent common ancestor
      --earliest-commit <id>   Earliest unique commit ID
      --mention <npub>         Mention user (can be specified multiple times)
    
    Example:
      gitrep publish pr-update npub1... myrepo pr-event-id new-commit-id \\
        --pr-author npub1... \\
        --clone-url "https://gitrepublic.com/api/git/npub1.../myrepo.git" \\
        --merge-base base-commit-id

  event [options]
    Publish a generic Nostr event (defaults to kind 1)
    Options:
      --kind <number>              Event kind (default: 1)
      --content <text>             Event content (default: '')
      --tag <name> <value>         Add a tag (can be specified multiple times)
      --no-client-tag              Don't add client tag (default: adds 'client' tag)
      --relay <url>                Custom relay URL (can be specified multiple times)
    
    Examples:
      gitrep publish event --kind 1 --content "Hello, Nostr!"
      gitrep publish event --kind 1 --content "Hello" --tag "p" "npub1..."
      gitrep publish event --kind 42 --content "" --tag "t" "hashtag" --tag "p" "npub1..."
      gitrep publish event --kind 1 --content "Test" --no-client-tag

Event Structure:
  All events are automatically signed with NOSTRGIT_SECRET_KEY and published to relays.
  Events are stored locally in nostr/ directory (JSONL format) for reference.
  
  For detailed event structure documentation, see:
  - https://github.com/silberengel/gitrepublic-web/tree/main/docs
  - docs/NIP_COMPLIANCE.md - NIP compliance and event kinds
  - docs/CustomKinds.md - Custom event kinds (1640, 1641, 30620)

Environment Variables:
  NOSTRGIT_SECRET_KEY           Required: Nostr private key (nsec or hex)
  NOSTR_RELAYS                  Optional: Comma-separated relay URLs (default: wss://theforest.nostr1.com,wss://relay.damus.io,wss://nostr.land)

For more information, see: https://github.com/silberengel/gitrepublic-cli
`);
}

// Export helper functions for subcommands
export { addClientTag };
