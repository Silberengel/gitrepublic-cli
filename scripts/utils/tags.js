/**
 * Add client tag to event tags unless --no-client-tag is specified
 * @param {Array} tags - Array of tag arrays
 * @param {Array} args - Command arguments array
 */
export function addClientTag(tags, args) {
  const noClientTag = args && args.includes('--no-client-tag');
  if (!noClientTag) {
    tags.push(['client', 'gitrepublic-cli']);
  }
  return tags;
}
