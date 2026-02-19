import { finalizeEvent } from 'nostr-tools';
import { decode } from 'nostr-tools/nip19';
import { nip19 } from 'nostr-tools';
import { publishEventCommon, addClientTag } from './index.js';

/**
 * Publish ownership transfer
 */
export async function publishOwnershipTransfer(args, relays, privateKeyBytes, pubkey, json) {
  const [repoName, newOwnerNpub] = args;
  if (!repoName || !newOwnerNpub) {
    console.error('Error: repo name and new owner npub required');
    console.error('Use: publish ownership-transfer <repo> <new-owner-npub> [--self-transfer]');
    console.error('Note: You must be the current owner (signing with NOSTRGIT_SECRET_KEY)');
    process.exit(1);
  }

  const selfTransfer = args.includes('--self-transfer');
  
  // Decode new owner npub to hex
  let newOwnerPubkey;
  try {
    newOwnerPubkey = newOwnerNpub.startsWith('npub') ? decode(newOwnerNpub).data : newOwnerNpub;
    // Convert to hex string if it's a Uint8Array
    if (newOwnerPubkey instanceof Uint8Array) {
      newOwnerPubkey = Array.from(newOwnerPubkey).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (err) {
    throw new Error(`Invalid npub format: ${err.message}`);
  }

  // Current owner is the pubkey from the signing key
  const currentOwnerPubkey = pubkey;
  const repoAddress = `30617:${currentOwnerPubkey}:${repoName}`;
  const tags = [
    ['a', repoAddress],
    ['p', newOwnerPubkey],
    ['d', repoName]
  ];

  if (selfTransfer) {
    tags.push(['t', 'self-transfer']);
  }

  // Add client tag unless --no-client-tag is specified
  addClientTag(tags, args);

  const event = finalizeEvent({
    kind: 1641, // OWNERSHIP_TRANSFER
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: ''
  }, privateKeyBytes);

  await publishEventCommon(event, relays, privateKeyBytes, pubkey, json, 'Ownership transfer');
  if (!json) {
    const currentOwnerNpub = nip19.npubEncode(currentOwnerPubkey);
    console.log(`Repository: ${currentOwnerNpub}/${repoName}`);
    console.log(`Current owner: ${currentOwnerNpub}`);
    console.log(`New owner: ${newOwnerNpub}`);
  }
}
