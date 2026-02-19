import { finalizeEvent } from 'nostr-tools';
import { publishEventCommon, addClientTag } from './index.js';

/**
 * Publish generic event
 */
export async function publishEvent(args, relays, privateKeyBytes, pubkey, json) {
  // Check for help
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Publish Generic Nostr Event

Usage: gitrep publish event [content] [options]

Description:
  Publish a generic Nostr event with any kind, content, and tags.
  Defaults to kind 1 (text note) if not specified.
  Content can be provided as a positional argument or with --content.

Options:
  --kind <number>              Event kind (default: 1)
  --content <text>             Event content (default: '')
  --tag <name> <value>         Add a tag (can be specified multiple times)
  --no-client-tag              Don't add client tag (default: adds 'client' tag)
  --relay <url>                Custom relay URL (can be specified multiple times)
  --help, -h                   Show this help message

Examples:
  gitrep publish event "Hello, Nostr!"                    # Simple text note
  gitrep publish event --kind 1 --content "Hello, Nostr!"
  gitrep publish event --kind 1 --content "Hello" --tag "p" "npub1..."
  gitrep publish event --kind 42 "" --tag "t" "hashtag" --tag "p" "npub1..."
  gitrep publish event "Test" --no-client-tag
  gitrep publish event "Test" --relay "wss://relay.example.com"

Notes:
  - All events are automatically signed with NOSTRGIT_SECRET_KEY
  - Events are stored locally in nostr/events-kind-<kind>.jsonl
  - Client tag is added by default unless --no-client-tag is specified
`);
    process.exit(0);
  }

  let kind = 1; // Default to kind 1
  let content = '';
  const tags = [];
  const customRelays = [];
  let positionalContent = null;

  // Parse options and positional arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--kind' && args[i + 1]) {
      kind = parseInt(args[++i], 10);
      if (isNaN(kind)) {
        console.error('Error: --kind must be a number');
        process.exit(1);
      }
    } else if (args[i] === '--content' && args[i + 1] !== undefined) {
      content = args[++i];
    } else if (args[i] === '--tag' && args[i + 1] && args[i + 2]) {
      const tagName = args[++i];
      const tagValue = args[++i];
      tags.push([tagName, tagValue]);
    } else if (args[i] === '--relay' && args[i + 1]) {
      customRelays.push(args[++i]);
    } else if (args[i] === '--no-client-tag') {
      // Handled by addClientTag function
    } else if (args[i] === '--help' || args[i] === '-h') {
      // Already handled above
    } else if (!args[i].startsWith('--')) {
      // Positional argument - treat as content if no --content was specified
      if (positionalContent === null && content === '') {
        positionalContent = args[i];
      } else {
        console.error(`Error: Unexpected positional argument: ${args[i]}`);
        console.error('Use: publish event [content] [options]');
        console.error('Run: publish event --help for detailed usage');
        process.exit(1);
      }
    } else {
      console.error(`Error: Unknown option: ${args[i]}`);
      console.error('Use: publish event [content] [options]');
      console.error('Run: publish event --help for detailed usage');
      process.exit(1);
    }
  }

  // Use positional content if provided and --content was not used
  if (positionalContent !== null && content === '') {
    content = positionalContent;
  }

  // Add client tag unless --no-client-tag is specified
  addClientTag(tags, args);

  // Use custom relays if provided, otherwise use defaults
  const eventRelays = customRelays.length > 0 ? customRelays : relays;

  const event = finalizeEvent({
    kind,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content
  }, privateKeyBytes);

  let result;
  try {
    result = await publishEventCommon(event, eventRelays, privateKeyBytes, pubkey, json, 'Event');
  } catch (error) {
    // Handle relay errors gracefully - don't crash
    const { sanitizeErrorMessage } = await import('../../utils/error-sanitizer.js');
    const errorMessage = error instanceof Error ? error.message : String(error);
    const sanitized = sanitizeErrorMessage(errorMessage);
    result = {
      success: [],
      failed: eventRelays.map(relay => ({ relay, error: sanitized }))
    };
  }
  
  if (!json) {
    console.log(`Kind: ${kind}`);
    console.log(`Content: ${content || '(empty)'}`);
    console.log(`Tags: ${tags.length}`);
    // Exit with error code only if all relays failed
    if (result.success.length === 0 && result.failed.length > 0) {
      process.exit(1);
    }
  }
}
