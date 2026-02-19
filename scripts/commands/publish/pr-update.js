import { finalizeEvent } from 'nostr-tools';
import { decode } from 'nostr-tools/nip19';
import { publishEventCommon, addClientTag } from './index.js';

/**
 * Publish pull request update
 */
export async function publishPRUpdate(args, relays, privateKeyBytes, pubkey, json) {
  const [ownerNpub, repoName, prEventId, commitId] = args;
  if (!ownerNpub || !repoName || !prEventId || !commitId) {
    console.error('Error: owner npub, repo name, PR event ID, and commit ID required');
    console.error('Use: publish pr-update <owner-npub> <repo> <pr-event-id> <commit-id> [options]');
    process.exit(1);
  }

  let ownerPubkey;
  try {
    ownerPubkey = ownerNpub.startsWith('npub') ? decode(ownerNpub).data : ownerNpub;
    if (ownerPubkey instanceof Uint8Array) {
      ownerPubkey = Array.from(ownerPubkey).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (err) {
    throw new Error(`Invalid npub format: ${err.message}`);
  }

  // Get PR author pubkey (needed for NIP-22 tags)
  let prAuthorPubkey = null;
  const cloneUrls = [];
  let mergeBase = null;
  let earliestCommit = null;
  const mentions = [];

  for (let i = 4; i < args.length; i++) {
    if (args[i] === '--pr-author' && args[i + 1]) {
      let authorNpub = args[++i];
      try {
        prAuthorPubkey = authorNpub.startsWith('npub') ? decode(authorNpub).data : authorNpub;
        if (prAuthorPubkey instanceof Uint8Array) {
          prAuthorPubkey = Array.from(prAuthorPubkey).map(b => b.toString(16).padStart(2, '0')).join('');
        }
      } catch (err) {
        throw new Error(`Invalid pr-author npub format: ${err.message}`);
      }
    } else if (args[i] === '--clone-url' && args[i + 1]) {
      cloneUrls.push(args[++i]);
    } else if (args[i] === '--merge-base' && args[i + 1]) {
      mergeBase = args[++i];
    } else if (args[i] === '--earliest-commit' && args[i + 1]) {
      earliestCommit = args[++i];
    } else if (args[i] === '--mention' && args[i + 1]) {
      mentions.push(args[++i]);
    }
  }

  const repoAddress = `30617:${ownerPubkey}:${repoName}`;
  const tags = [
    ['a', repoAddress],
    ['p', ownerPubkey],
    ['E', prEventId], // NIP-22 root event reference
    ['c', commitId]
  ];

  // Add earliest commit if provided
  if (earliestCommit) {
    tags.push(['r', earliestCommit, 'euc']);
  }

  // Add mentions
  for (const mention of mentions) {
    let mentionPubkey = mention;
    try {
      if (mention.startsWith('npub')) {
        mentionPubkey = decode(mention).data;
        if (mentionPubkey instanceof Uint8Array) {
          mentionPubkey = Array.from(mentionPubkey).map(b => b.toString(16).padStart(2, '0')).join('');
        }
      }
    } catch {
      // Keep original if decode fails
    }
    tags.push(['p', mentionPubkey]);
  }

  // Add PR author if provided (NIP-22 root pubkey reference)
  if (prAuthorPubkey) {
    tags.push(['P', prAuthorPubkey]);
  }

  // Add clone URLs (required)
  if (cloneUrls.length === 0) {
    console.error('Error: At least one --clone-url is required');
    process.exit(1);
  }
  for (const url of cloneUrls) {
    tags.push(['clone', url]);
  }

  // Add merge base if provided
  if (mergeBase) {
    tags.push(['merge-base', mergeBase]);
  }

  // Add client tag unless --no-client-tag is specified
  addClientTag(tags, args);

  const event = finalizeEvent({
    kind: 1619, // PULL_REQUEST_UPDATE
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: ''
  }, privateKeyBytes);

  await publishEventCommon(event, relays, privateKeyBytes, pubkey, json, 'Pull request update');
  if (!json) {
    console.log(`Repository: ${ownerNpub}/${repoName}`);
    console.log(`PR Event ID: ${prEventId}`);
    console.log(`New commit: ${commitId}`);
  }
}
