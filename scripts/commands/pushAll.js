import { execSync } from 'child_process';

/**
 * Push to all remotes
 */
export async function pushAll(args, server, json) {
  // Check for help flag
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Push to All Remotes

Usage: gitrep push-all [branch] [options]

Description:
  Pushes the current branch (or specified branch) to all configured git remotes.
  This is useful when you have multiple remotes (e.g., GitHub, GitLab, GitRepublic)
  and want to push to all of them at once.

Arguments:
  branch                    Optional branch name to push. If not specified, pushes all branches.

Options:
  --force, -f               Force push (use with caution)
  --tags                    Also push tags
  --dry-run, -n             Show what would be pushed without actually pushing
  --help, -h                Show this help message

Examples:
  gitrep push-all                    Push all branches to all remotes
  gitrep push-all main               Push main branch to all remotes
  gitrep push-all main --force       Force push main branch to all remotes
  gitrep push-all --tags             Push all branches and tags to all remotes
  gitrep push-all main --dry-run     Show what would be pushed without pushing

Notes:
  - This command requires you to be in a git repository
  - It will push to all remotes listed by 'git remote'
  - If any remote fails, the command will exit with an error code
  - Use --dry-run to test before actually pushing
`);
    return;
  }
  
  // Parse arguments
  const branch = args.find(arg => !arg.startsWith('--'));
  const force = args.includes('--force') || args.includes('-f');
  const tags = args.includes('--tags');
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  
  // Get all remotes
  let remotes = [];
  try {
    const remoteOutput = execSync('git remote', { encoding: 'utf-8' }).trim();
    remotes = remoteOutput.split('\n').filter(r => r.trim());
  } catch (err) {
    console.error('Error: Not in a git repository or unable to read remotes');
    console.error(err instanceof Error ? err.message : 'Unknown error');
    process.exit(1);
  }
  
  if (remotes.length === 0) {
    console.error('Error: No remotes configured');
    process.exit(1);
  }
  
  // Build push command
  const pushArgs = [];
  if (force) pushArgs.push('--force');
  if (tags) pushArgs.push('--tags');
  if (dryRun) pushArgs.push('--dry-run');
  if (branch) {
    // If branch is specified, push to each remote with that branch
    pushArgs.push(branch);
  } else {
    // Push all branches
    pushArgs.push('--all');
  }
  
  const results = [];
  let successCount = 0;
  let failCount = 0;
  
  for (const remote of remotes) {
    try {
      if (!json && !dryRun) {
        console.log(`\nPushing to ${remote}...`);
      }
      
      const command = ['push', remote, ...pushArgs];
      
      execSync(`git ${command.join(' ')}`, {
        stdio: json ? 'pipe' : 'inherit',
        encoding: 'utf-8'
      });
      
      results.push({ remote, status: 'success' });
      successCount++;
      
      if (!json && !dryRun) {
        console.log(`✅ Successfully pushed to ${remote}`);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      results.push({ remote, status: 'failed', error: errorMessage });
      failCount++;
      
      if (!json && !dryRun) {
        console.error(`❌ Failed to push to ${remote}: ${errorMessage}`);
      }
    }
  }
  
  if (json) {
    console.log(JSON.stringify({
      total: remotes.length,
      success: successCount,
      failed: failCount,
      results
    }, null, 2));
  } else {
    console.log('\n' + '='.repeat(70));
    console.log(`Push Summary: ${successCount} succeeded, ${failCount} failed out of ${remotes.length} remotes`);
    console.log('='.repeat(70));
    
    if (failCount > 0) {
      console.log('\nFailed remotes:');
      results.filter(r => r.status === 'failed').forEach(r => {
        console.log(`  ${r.remote}: ${r.error}`);
      });
      process.exit(1);
    }
  }
}
