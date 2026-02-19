import { apiRequest } from '../utils/api.js';

/**
 * Search repositories
 */
export async function search(args, server, json) {
  const query = args.join(' ');
  if (!query) {
    console.error('Search query required');
    process.exit(1);
  }
  const data = await apiRequest(server, `/search?q=${encodeURIComponent(query)}`, 'GET');
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`Search results for "${query}":`);
    if (Array.isArray(data)) {
      data.forEach(repo => {
        console.log(`  ${repo.npub}/${repo.name} - ${repo.description || 'No description'}`);
      });
    }
  }
}
