import { finalizeEvent } from 'nostr-tools';
import { publishEventCommon, addClientTag } from './index.js';

/**
 * Publish status event
 */
export async function publishStatus(args, relays, privateKeyBytes, pubkey, json) {
  const [eventId, status] = args;
  if (!eventId || !status) {
    console.error('Error: event ID and status required');
    console.error('Use: publish status <event-id> <open|applied|closed|draft> [--content <text>]');
    process.exit(1);
  }

  const statusKinds = {
    'open': 1630,
    'applied': 1631,
    'closed': 1632,
    'draft': 1633
  };

  const kind = statusKinds[status.toLowerCase()];
  if (!kind) {
    console.error(`Error: Invalid status. Use: open, applied, closed, or draft`);
    process.exit(1);
  }

  const tags = [['e', eventId]];
  let content = '';

  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--content' && args[i + 1]) {
      content = args[++i];
    }
  }

  // Add client tag unless --no-client-tag is specified
  addClientTag(tags, args);

  const event = finalizeEvent({
    kind,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content
  }, privateKeyBytes);

  await publishEventCommon(event, relays, privateKeyBytes, pubkey, json, 'Status event');
  if (!json) {
    console.log(`Status: ${status}`);
    console.log(`Target event: ${eventId}`);
  }
}
