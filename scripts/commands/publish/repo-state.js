import { finalizeEvent } from 'nostr-tools';
import { nip19 } from 'nostr-tools';
import { publishEventCommon, addClientTag } from './index.js';

/**
 * Publish repository state
 */
export async function publishRepoState(args, relays, privateKeyBytes, pubkey, json) {
  const repoName = args[0];
  if (!repoName) {
    console.error('Error: Repository name required');
    console.error('Use: publish repo-state <repo> [options]');
    process.exit(1);
  }

  // Current owner is the pubkey from the signing key
  const currentOwnerPubkey = pubkey;
  const tags = [['d', repoName]];
  let headBranch = null;

  // Parse options
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--ref' && args[i + 2]) {
      const refPath = args[++i];
      const commitId = args[++i];
      const refTag = [refPath, commitId];
      
      // Check for parent commits
      while (i + 1 < args.length && args[i + 1] !== '--ref' && args[i + 1] !== '--head') {
        refTag.push(args[++i]);
      }
      
      tags.push(refTag);
    } else if (args[i] === '--head' && args[i + 1]) {
      headBranch = args[++i];
      tags.push(['HEAD', `ref: refs/heads/${headBranch}`]);
    }
  }

  // Add client tag unless --no-client-tag is specified
  addClientTag(tags, args);

  const event = finalizeEvent({
    kind: 30618, // REPO_STATE
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: ''
  }, privateKeyBytes);

  await publishEventCommon(event, relays, privateKeyBytes, pubkey, json, 'Repository state');
  if (!json) {
    const currentOwnerNpub = nip19.npubEncode(currentOwnerPubkey);
    console.log(`Repository: ${currentOwnerNpub}/${repoName}`);
    if (headBranch) {
      console.log(`HEAD: ${headBranch}`);
    }
    console.log(`Refs: ${tags.filter(t => t[0].startsWith('refs/')).length}`);
  }
}
