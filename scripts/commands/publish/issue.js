import { finalizeEvent } from 'nostr-tools';
import { decode } from 'nostr-tools/nip19';
import { publishEventCommon, addClientTag } from './index.js';

/**
 * Publish issue
 */
export async function publishIssue(args, relays, privateKeyBytes, pubkey, json) {
  const [ownerNpub, repoName, title] = args;
  if (!ownerNpub || !repoName || !title) {
    console.error('Error: owner npub, repo name, and title required');
    console.error('Use: publish issue <owner-npub> <repo> <title> [options]');
    process.exit(1);
  }

  let ownerPubkey;
  try {
    ownerPubkey = ownerNpub.startsWith('npub') ? decode(ownerNpub).data : ownerNpub;
  } catch (err) {
    throw new Error(`Invalid npub format: ${err.message}`);
  }

  const repoAddress = `30617:${ownerPubkey}:${repoName}`;
  const tags = [
    ['a', repoAddress],
    ['p', ownerPubkey],
    ['subject', title]
  ];

  let content = '';
  const labels = [];

  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--content' && args[i + 1]) {
      content = args[++i];
    } else if (args[i] === '--label' && args[i + 1]) {
      labels.push(args[++i]);
    }
  }

  for (const label of labels) {
    tags.push(['t', label]);
  }

  // Add client tag unless --no-client-tag is specified
  addClientTag(tags, args);

  const event = finalizeEvent({
    kind: 1621, // ISSUE
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content
  }, privateKeyBytes);

  await publishEventCommon(event, relays, privateKeyBytes, pubkey, json, 'Issue');
  if (!json) {
    console.log(`Repository: ${ownerNpub}/${repoName}`);
    console.log(`Title: ${title}`);
  }
}
