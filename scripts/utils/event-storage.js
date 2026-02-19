import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

/**
 * Store event in appropriate JSONL file based on event kind
 * Security: Uses fs.mkdirSync instead of execSync to prevent command injection
 */
export function storeEventInJsonl(event) {
  try {
    // Find repository root (look for .git directory)
    let repoRoot = null;
    let currentDir = process.cwd();
    
    for (let i = 0; i < 10; i++) {
      const potentialGitDir = join(currentDir, '.git');
      if (existsSync(potentialGitDir)) {
        repoRoot = currentDir;
        break;
      }
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
    
    if (!repoRoot) {
      // Not in a git repo, skip storing
      return;
    }
    
    // Create nostr/ directory if it doesn't exist
    // Security: Use fs.mkdirSync instead of execSync for path safety
    const nostrDir = join(repoRoot, 'nostr');
    if (!existsSync(nostrDir)) {
      mkdirSync(nostrDir, { recursive: true });
    }
    
    // Determine JSONL file name based on event kind
    let jsonlFile;
    switch (event.kind) {
      case 30617: // REPO_ANNOUNCEMENT
        jsonlFile = join(nostrDir, 'repo-announcements.jsonl');
        break;
      case 1641: // OWNERSHIP_TRANSFER
        jsonlFile = join(nostrDir, 'ownership-transfers.jsonl');
        break;
      case 1617: // PATCH
        jsonlFile = join(nostrDir, 'patches.jsonl');
        break;
      case 1618: // PULL_REQUEST
        jsonlFile = join(nostrDir, 'pull-requests.jsonl');
        break;
      case 1619: // PULL_REQUEST_UPDATE
        jsonlFile = join(nostrDir, 'pull-request-updates.jsonl');
        break;
      case 1621: // ISSUE
        jsonlFile = join(nostrDir, 'issues.jsonl');
        break;
      case 1630: // STATUS_OPEN
      case 1631: // STATUS_APPLIED
      case 1632: // STATUS_CLOSED
      case 1633: // STATUS_DRAFT
        jsonlFile = join(nostrDir, 'status-events.jsonl');
        break;
      case 30618: // REPO_STATE
        jsonlFile = join(nostrDir, 'repo-states.jsonl');
        break;
      default:
        // Store unknown event types in a generic file
        jsonlFile = join(nostrDir, `events-kind-${event.kind}.jsonl`);
    }
    
    // Append event to JSONL file
    const eventLine = JSON.stringify(event) + '\n';
    writeFileSync(jsonlFile, eventLine, { flag: 'a', encoding: 'utf-8' });
  } catch (error) {
    // Silently fail - storing is optional
  }
}
