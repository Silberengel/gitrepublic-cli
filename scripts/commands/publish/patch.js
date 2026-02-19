import { readFileSync } from 'fs';
import { finalizeEvent } from 'nostr-tools';
import { decode } from 'nostr-tools/nip19';
import { publishEventCommon, addClientTag } from './index.js';

/**
 * Publish patch
 */
export async function publishPatch(args, relays, privateKeyBytes, pubkey, json) {
  const [ownerNpub, repoName, patchFile] = args;
  if (!ownerNpub || !repoName || !patchFile) {
    console.error('Error: owner npub, repo name, and patch file required');
    console.error('Use: publish patch <owner-npub> <repo> <patch-file> [options]');
    console.error('Note: Patch file should be generated with: git format-patch');
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

  // Read patch file
  let patchContent;
  try {
    patchContent = readFileSync(patchFile, 'utf-8');
  } catch (err) {
    throw new Error(`Failed to read patch file: ${err.message}`);
  }

  const repoAddress = `30617:${ownerPubkey}:${repoName}`;
  const tags = [
    ['a', repoAddress],
    ['p', ownerPubkey]
  ];

  // Parse options
  let earliestCommit = null;
  let commitId = null;
  let parentCommit = null;
  let isRoot = false;
  let isRootRevision = false;
  const mentions = [];

  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--earliest-commit' && args[i + 1]) {
      earliestCommit = args[++i];
      tags.push(['r', earliestCommit]);
    } else if (args[i] === '--commit' && args[i + 1]) {
      commitId = args[++i];
      tags.push(['commit', commitId]);
      tags.push(['r', commitId]);
    } else if (args[i] === '--parent-commit' && args[i + 1]) {
      parentCommit = args[++i];
      tags.push(['parent-commit', parentCommit]);
    } else if (args[i] === '--root') {
      isRoot = true;
      tags.push(['t', 'root']);
    } else if (args[i] === '--root-revision') {
      isRootRevision = true;
      tags.push(['t', 'root-revision']);
    } else if (args[i] === '--mention' && args[i + 1]) {
      mentions.push(args[++i]);
    } else if (args[i] === '--reply-to' && args[i + 1]) {
      // NIP-10 reply tag
      tags.push(['e', args[++i], '', 'reply']);
    }
  }

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

  // Add client tag unless --no-client-tag is specified
  addClientTag(tags, args);

  const event = finalizeEvent({
    kind: 1617, // PATCH
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: patchContent
  }, privateKeyBytes);

  await publishEventCommon(event, relays, privateKeyBytes, pubkey, json, 'Patch');
  if (!json) {
    console.log(`Repository: ${ownerNpub}/${repoName}`);
    console.log(`Patch file: ${patchFile}`);
  }
}
