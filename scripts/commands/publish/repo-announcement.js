import { finalizeEvent } from 'nostr-tools';
import { publishEventCommon, addClientTag } from './index.js';

/**
 * Publish repository announcement
 */
export async function publishRepoAnnouncement(args, relays, privateKeyBytes, pubkey, json) {
  const repoName = args[0];
  if (!repoName) {
    console.error('Error: Repository name required');
    console.error('Use: publish repo-announcement <repo-name> [options]');
    process.exit(1);
  }

  const tags = [['d', repoName]];
  let description = '';
  const cloneUrls = [];
  const webUrls = [];
  const maintainers = [];

  // Parse options
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--description' && args[i + 1]) {
      description = args[++i];
    } else if (args[i] === '--clone-url' && args[i + 1]) {
      cloneUrls.push(args[++i]);
    } else if (args[i] === '--web-url' && args[i + 1]) {
      webUrls.push(args[++i]);
    } else if (args[i] === '--maintainer' && args[i + 1]) {
      maintainers.push(args[++i]);
    } else if (args[i] === '--relay' && args[i + 1]) {
      relays.push(args[++i]);
    }
  }

  // Add clone URLs
  for (const url of cloneUrls) {
    tags.push(['r', url]);
  }

  // Add web URLs
  for (const url of webUrls) {
    tags.push(['web', url]);
  }

  // Add maintainers
  for (const maintainer of maintainers) {
    tags.push(['p', maintainer]);
  }

  // Add client tag unless --no-client-tag is specified
  addClientTag(tags, args);

  const event = finalizeEvent({
    kind: 30617, // REPO_ANNOUNCEMENT
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: description
  }, privateKeyBytes);

  await publishEventCommon(event, relays, privateKeyBytes, pubkey, json, 'Repository announcement');
  if (!json) {
    console.log(`Repository: ${repoName}`);
  }
}
