// Note: Using spawn instead of execSync for security (prevents command injection)

/**
 * Get the URL for a git remote
 */
async function getRemoteUrl(remote) {
  const { spawn } = await import('child_process');
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['remote', 'get-url', remote], { encoding: 'utf-8' });
    let output = '';
    proc.stdout.on('data', (chunk) => { output += chunk.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`git remote get-url exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

/**
 * Check if a URL is an SSH URL (git@host:path or ssh://)
 */
function isSshUrl(url) {
  return url.startsWith('git@') || url.startsWith('ssh://') || /^[a-zA-Z0-9_]+@/.test(url);
}

/**
 * Convert SSH URL to HTTPS URL for reachability testing
 * Examples:
 *   git@github.com:user/repo.git -> https://github.com/user/repo.git
 *   git@git.imwald.eu:2222/user/repo.git -> https://git.imwald.eu/user/repo.git
 *   ssh://git@host:port/path -> https://host/path
 */
function sshToHttps(url) {
  // Handle ssh:// URLs
  if (url.startsWith('ssh://')) {
    const match = url.match(/^ssh:\/\/(?:[^@]+@)?([^:\/]+)(?::(\d+))?(?:\/(.+))?$/);
    if (match) {
      const [, host, port, path] = match;
      const cleanPath = path || '';
      // Remove port from HTTPS URL (ports are usually SSH-specific)
      return `https://${host}${cleanPath.startsWith('/') ? cleanPath : '/' + cleanPath}`;
    }
  }
  
  // Handle git@host:path format
  if (url.startsWith('git@') || /^[a-zA-Z0-9_]+@/.test(url)) {
    const match = url.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
    if (match) {
      const [, host, path] = match;
      // Remove port if present (e.g., git.imwald.eu:2222 -> git.imwald.eu)
      const hostWithoutPort = host.split(':')[0];
      const cleanPath = path.startsWith('/') ? path : '/' + path;
      return `https://${hostWithoutPort}${cleanPath}`;
    }
  }
  
  return null;
}

/**
 * Check if a git URL is reachable
 * Tests the info/refs endpoint to see if the server responds
 * Converts SSH URLs to HTTPS for testing
 */
async function checkUrlReachability(url, timeout = 5000) {
  let testUrl = url;
  
  // Convert SSH URLs to HTTPS for testing
  if (isSshUrl(url)) {
    const httpsUrl = sshToHttps(url);
    if (httpsUrl) {
      testUrl = httpsUrl;
    } else {
      // If we can't convert, assume reachable (will fail on actual fetch if not)
      return { reachable: true, error: undefined };
    }
  }
  
  try {
    // Parse URL and construct test endpoint
    let finalTestUrl = testUrl;
    
    // Handle git:// URLs
    if (finalTestUrl.startsWith('git://')) {
      finalTestUrl = finalTestUrl.replace('git://', 'http://');
    }
    
    // Ensure URL ends with .git for the test
    if (!finalTestUrl.endsWith('.git')) {
      finalTestUrl = finalTestUrl.replace(/\/$/, '') + '.git';
    }
    
    const urlObj = new URL(finalTestUrl);
    
    // Only test HTTP/HTTPS URLs
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      // For other protocols, assume reachable
      return { reachable: true, error: undefined };
    }
    
    const testEndpoint = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}/info/refs?service=git-upload-pack`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
      const response = await fetch(testEndpoint, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'GitRepublic-CLI/1.0'
        }
      });
      
      clearTimeout(timeoutId);
      // Any HTTP status < 600 means server is reachable
      return { reachable: response.status < 600, error: response.status >= 600 ? `HTTP ${response.status}` : undefined };
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        return { reachable: false, error: 'Timeout' };
      }
      return { reachable: false, error: fetchError instanceof Error ? fetchError.message : 'Network error' };
    }
  } catch (urlError) {
    // If URL parsing fails, it might be a malformed URL
    // For SSH URLs that we couldn't convert, assume reachable (will fail on actual fetch if not)
    if (isSshUrl(url)) {
      return { reachable: true, error: undefined };
    }
    return { reachable: false, error: urlError instanceof Error ? urlError.message : 'Invalid URL' };
  }
}

/**
 * Check if merge would have conflicts (dry-run)
 * Uses git merge-tree for a true dry-run without modifying the working tree
 */
async function checkMergeConflicts(remoteBranch, currentBranch, rebase = false) {
  const { spawn } = await import('child_process');
  
  if (rebase) {
    // For rebase, check if branches have diverged
    // If currentBranch is an ancestor of remoteBranch, it's a fast-forward (no conflict)
    // If they've diverged, there could be conflicts
    return new Promise((resolve) => {
      // First check if currentBranch is ancestor of remoteBranch (fast-forward case)
      const ancestorProc = spawn('git', ['merge-base', '--is-ancestor', currentBranch, remoteBranch], {
        stdio: 'pipe',
        encoding: 'utf-8'
      });
      ancestorProc.on('close', (ancestorCode) => {
        if (ancestorCode === 0) {
          // Fast-forward possible, no conflict
          resolve(false);
        } else {
          // Branches have diverged, check if merge would conflict
          // Use merge-tree to check for conflicts
          const mergeTreeProc = spawn('git', ['merge-tree', currentBranch, remoteBranch], {
            stdio: 'pipe',
            encoding: 'utf-8'
          });
          let output = '';
          mergeTreeProc.stdout.on('data', (chunk) => { output += chunk.toString(); });
          mergeTreeProc.stderr.on('data', (chunk) => { output += chunk.toString(); });
          mergeTreeProc.on('close', (code) => {
            // If output contains conflict markers or exit code indicates conflict
            const hasConflicts = output.includes('<<<<<<<') || 
                                output.includes('=======') || 
                                output.includes('>>>>>>>') ||
                                code !== 0;
            resolve(hasConflicts);
          });
          mergeTreeProc.on('error', () => resolve(true)); // Assume conflict on error
        }
      });
      ancestorProc.on('error', () => resolve(true)); // Assume conflict on error
    });
  } else {
    // For merge, use merge-tree to check for conflicts without modifying working tree
    return new Promise((resolve) => {
      const proc = spawn('git', ['merge-tree', currentBranch, remoteBranch], {
        stdio: 'pipe',
        encoding: 'utf-8'
      });
      let output = '';
      proc.stdout.on('data', (chunk) => { output += chunk.toString(); });
      proc.stderr.on('data', (chunk) => { output += chunk.toString(); });
      proc.on('close', (code) => {
        // Check for conflict markers in output
        const hasConflicts = output.includes('<<<<<<<') || 
                            output.includes('=======') || 
                            output.includes('>>>>>>>') ||
                            code !== 0;
        resolve(hasConflicts);
      });
      proc.on('error', () => resolve(true)); // Assume conflict on error
    });
  }
}

/**
 * Fetch from all remotes and optionally merge/rebase changes
 * Security: Uses spawn with argument arrays to prevent command injection
 * 
 * This command fetches from all configured git remotes sequentially and optionally
 * merges or rebases the changes into your current branch. It always does a dry-run
 * first to check for conflicts, and requires explicit confirmation if conflicts are
 * detected.
 */
export async function pullAll(args, server, json) {
  // Check for help flag
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Fetch and Merge from All Remotes

Usage: gitrep pull-all [branch] [options]

Description:
  Fetches from all configured git remotes sequentially and optionally merges
  or rebases the changes into your current branch (or specified branch).
  This is useful when you have multiple remotes and want to pull changes from
  all of them, such as from GRASP servers, GitHub, GitLab, etc.

Arguments:
  branch                    Optional branch name. If not specified, uses current branch.

Options:
  --merge                   Merge changes from remotes into current branch (default: fetch only)
  --rebase                  Rebase current branch onto remote branches (instead of merge)
  --no-ff                   Create merge commit even if fast-forward is possible (with --merge)
  --allow-conflicts         Allow proceeding even if conflicts are detected (default: abort on conflicts)
  --skip-reachability       Skip reachability check (attempt to fetch from all remotes regardless)
  --dry-run, -n             Show what would be fetched/merged without actually doing it
  --help, -h                Show this help message

Examples:
  gitrep pull-all                    Fetch from all remotes (no merge)
  gitrep pull-all --merge            Fetch and merge changes from all remotes
  gitrep pull-all main --merge        Fetch and merge main branch from all remotes
  gitrep pull-all --rebase            Fetch and rebase current branch onto remotes
  gitrep pull-all --merge --no-ff     Fetch and merge with merge commits

Notes:
  - This command requires you to be in a git repository
  - It will fetch from all remotes listed by 'git remote'
  - Checks reachability of each remote before fetching (skips unreachable ones)
  - Aborts if no remotes are reachable
  - By default, only fetches (doesn't merge) - use --merge or --rebase to integrate changes
  - Always performs a conflict check first - aborts if conflicts detected (unless --allow-conflicts)
  - If multiple remotes have the same branch, merges/rebases happen sequentially
  - Use --allow-conflicts if you want to proceed despite conflicts (you'll resolve manually)
  - Use --skip-reachability to bypass reachability checks
  - Use --dry-run to see what would happen without making changes
`);
    return;
  }
  
  // Parse arguments
  const branch = args.find(arg => !arg.startsWith('--'));
  const merge = args.includes('--merge');
  const rebase = args.includes('--rebase');
  const noff = args.includes('--no-ff');
  const allowConflicts = args.includes('--allow-conflicts');
  const skipReachabilityCheck = args.includes('--skip-reachability');
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  
  // Validate options
  if (merge && rebase) {
    console.error('Error: Cannot use both --merge and --rebase. Choose one.');
    process.exit(1);
  }
  
  // Get all remotes
  // Security: Use spawn with argument arrays to prevent command injection
  let remotes = [];
  try {
    const { spawn } = await import('child_process');
    const remoteOutput = await new Promise((resolve, reject) => {
      const proc = spawn('git', ['remote'], { encoding: 'utf-8' });
      let output = '';
      proc.stdout.on('data', (chunk) => { output += chunk.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve(output.trim());
        else reject(new Error(`git remote exited with code ${code}`));
      });
      proc.on('error', reject);
    });
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
  
  // Get remote URLs and check reachability
  const remoteInfo = [];
  if (!skipReachabilityCheck && !dryRun) {
    if (!json) {
      console.log('Checking remote reachability...');
    }
    for (const remote of remotes) {
      try {
        const remoteUrl = await getRemoteUrl(remote);
        const reachability = await checkUrlReachability(remoteUrl);
        remoteInfo.push({ remote, url: remoteUrl, ...reachability });
        
        if (!json) {
          const status = reachability.reachable ? '✅' : '❌';
          console.log(`  ${status} ${remote} (${remoteUrl})${reachability.error ? ` - ${reachability.error}` : ''}`);
        }
      } catch (err) {
        // If we can't get URL or check reachability, assume reachable (fallback)
        remoteInfo.push({ remote, url: 'unknown', reachable: true, error: undefined });
        if (!json) {
          console.log(`  ⚠️  ${remote} - Could not check reachability, will attempt fetch`);
        }
      }
    }
  } else {
    // Skip reachability check - assume all are reachable
    for (const remote of remotes) {
      try {
        const remoteUrl = await getRemoteUrl(remote);
        remoteInfo.push({ remote, url: remoteUrl, reachable: true });
      } catch {
        remoteInfo.push({ remote, url: 'unknown', reachable: true });
      }
    }
  }
  
  // Filter to only reachable remotes
  const reachableRemotes = remoteInfo.filter(info => info.reachable);
  const unreachableRemotes = remoteInfo.filter(info => !info.reachable);
  
  // Abort if no remotes are reachable
  if (reachableRemotes.length === 0) {
    console.error('\n❌ Error: No reachable remotes found');
    if (unreachableRemotes.length > 0) {
      console.error('\nUnreachable remotes:');
      unreachableRemotes.forEach(({ remote, url, error }) => {
        console.error(`  - ${remote} (${url})${error ? `: ${error}` : ''}`);
      });
    }
    console.error('\nCannot proceed without at least one reachable remote.');
    console.error('Use --skip-reachability to bypass this check (not recommended).');
    process.exit(1);
  }
  
  if (unreachableRemotes.length > 0 && !json) {
    console.log(`\n⚠️  Skipping ${unreachableRemotes.length} unreachable remote(s):`);
    unreachableRemotes.forEach(({ remote, url, error }) => {
      console.log(`  - ${remote} (${url})${error ? `: ${error}` : ''}`);
    });
    console.log('');
  }
  
  // Update remotes list to only include reachable ones
  remotes = reachableRemotes.map(info => info.remote);
  
  // Get current branch if not specified
  let currentBranch = branch;
  if (!currentBranch) {
    try {
      const { spawn } = await import('child_process');
      const branchOutput = await new Promise((resolve, reject) => {
        const proc = spawn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' });
        let output = '';
        proc.stdout.on('data', (chunk) => { output += chunk.toString(); });
        proc.on('close', (code) => {
          if (code === 0) resolve(output.trim());
          else reject(new Error(`git rev-parse exited with code ${code}`));
        });
        proc.on('error', reject);
      });
      currentBranch = branchOutput;
    } catch (err) {
      console.error('Error: Could not determine current branch');
      console.error(err instanceof Error ? err.message : 'Unknown error');
      process.exit(1);
    }
  }
  
  const results = [];
  let successCount = 0;
  let failCount = 0;
  let mergeCount = 0;
  let conflictCount = 0;
  const potentialConflicts = [];
  
  if (!json && !dryRun) {
    console.log(`Fetching from ${remotes.length} remote(s) and ${merge ? 'merging' : rebase ? 'rebasing' : 'fetching'} changes...`);
    console.log(`Target branch: ${currentBranch}\n`);
  }
  
  // Phase 1: Fetch from all remotes first
  if (!json && !dryRun) {
    console.log('Phase 1: Fetching from all remotes...');
  }
  
  for (const remote of remotes) {
    try {
      if (!json && !dryRun) {
        console.log(`\nFetching from ${remote}...`);
      }
      
      const { spawn } = await import('child_process');
      
      // Fetch from remote
      if (!dryRun) {
        await new Promise((resolve, reject) => {
          const proc = spawn('git', ['fetch', remote], {
            stdio: json ? 'pipe' : 'inherit',
            encoding: 'utf-8'
          });
          proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`git fetch exited with code ${code}`));
          });
          proc.on('error', reject);
        });
        
        if (!json && !dryRun) {
          console.log(`  ✅ Fetched from ${remote}`);
        }
      } else {
        if (!json) {
          console.log(`  [DRY RUN] Would fetch from ${remote}`);
        }
      }
      
      results.push({ remote, status: 'fetched', branch: currentBranch });
      successCount++;
      
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      results.push({ remote, status: 'fetch-failed', error: errorMessage, branch: currentBranch });
      failCount++;
      
      if (!json && !dryRun) {
        console.error(`  ❌ Failed to fetch from ${remote}: ${errorMessage}`);
      }
    }
  }
  
  // Phase 2: Check for conflicts (if merge/rebase requested)
  if ((merge || rebase) && !dryRun) {
    if (!json) {
      console.log('\n' + '='.repeat(70));
      console.log('Phase 2: Checking for potential conflicts...');
      console.log('='.repeat(70));
    }
    
    for (const remote of remotes) {
      const remoteBranch = `${remote}/${currentBranch}`;
      
      // Check if remote branch exists
      let remoteBranchExists = false;
      try {
        const { spawn } = await import('child_process');
        await new Promise((resolve, reject) => {
          const proc = spawn('git', ['rev-parse', '--verify', `refs/remotes/${remoteBranch}`], {
            stdio: 'pipe',
            encoding: 'utf-8'
          });
          proc.on('close', (code) => {
            if (code === 0) {
              remoteBranchExists = true;
              resolve();
            } else {
              resolve(); // Branch doesn't exist, that's okay
            }
          });
          proc.on('error', reject);
        });
      } catch {
        // Branch doesn't exist, skip
      }
      
      if (remoteBranchExists) {
        if (!json) {
          console.log(`\nChecking ${remoteBranch}...`);
        }
        
        const hasConflicts = await checkMergeConflicts(remoteBranch, currentBranch, rebase);
        
        if (hasConflicts) {
          potentialConflicts.push({ remote, remoteBranch });
          if (!json) {
            console.log(`  ⚠️  Potential conflicts detected with ${remoteBranch}`);
          }
        } else {
          if (!json) {
            console.log(`  ✅ No conflicts with ${remoteBranch}`);
          }
        }
      }
    }
    
    // If conflicts detected and not allowed, abort
    if (potentialConflicts.length > 0 && !allowConflicts) {
      console.error('\n' + '='.repeat(70));
      console.error('❌ CONFLICTS DETECTED - Aborting');
      console.error('='.repeat(70));
      console.error(`\nPotential conflicts detected with ${potentialConflicts.length} remote(s):`);
      potentialConflicts.forEach(({ remote, remoteBranch }) => {
        console.error(`  - ${remote}: ${remoteBranch}`);
      });
      console.error('\nTo proceed despite conflicts, use --allow-conflicts flag:');
      console.error(`  gitrep pull-all ${merge ? '--merge' : '--rebase'} --allow-conflicts`);
      console.error('\nYou will need to resolve conflicts manually if you proceed.');
      process.exit(1);
    } else if (potentialConflicts.length > 0 && allowConflicts) {
      if (!json) {
        console.log('\n⚠️  Conflicts detected but --allow-conflicts specified, proceeding...');
        console.log('You will need to resolve conflicts manually.');
      }
    } else {
      if (!json) {
        console.log('\n✅ No conflicts detected, proceeding with merge/rebase...');
      }
    }
  }
  
  // Phase 3: Perform merges/rebases (if requested and no conflicts or conflicts allowed)
  if ((merge || rebase) && !dryRun && (potentialConflicts.length === 0 || allowConflicts)) {
    if (!json) {
      console.log('\n' + '='.repeat(70));
      console.log('Phase 3: Merging/Rebasing changes...');
      console.log('='.repeat(70));
    }
    
    for (const remote of remotes) {
      try {
        if (!json) {
          console.log(`\nMerging/Rebasing from ${remote}...`);
        }
        
        const { spawn } = await import('child_process');
        
        const remoteBranch = `${remote}/${currentBranch}`;
        
        // Check if remote branch exists
        let remoteBranchExists = false;
        try {
          await new Promise((resolve, reject) => {
            const proc = spawn('git', ['rev-parse', '--verify', `refs/remotes/${remoteBranch}`], {
              stdio: 'pipe',
              encoding: 'utf-8'
            });
            proc.on('close', (code) => {
              if (code === 0) {
                remoteBranchExists = true;
                resolve();
              } else {
                resolve(); // Branch doesn't exist, that's okay
              }
            });
            proc.on('error', reject);
          });
        } catch {
          // Branch doesn't exist, skip merge/rebase
        }
        
        if (remoteBranchExists) {
          // Check if this remote had conflicts (skip if conflicts not allowed)
          const hasConflict = potentialConflicts.some(c => c.remote === remote);
          if (hasConflict && !allowConflicts) {
            // Shouldn't reach here, but just in case
            continue;
          }
          
          if (merge) {
            const mergeArgs = ['merge', remoteBranch];
            if (noff) mergeArgs.push('--no-ff');
            
            try {
              await new Promise((resolve, reject) => {
                const proc = spawn('git', mergeArgs, {
                  stdio: json ? 'pipe' : 'inherit',
                  encoding: 'utf-8'
                });
                proc.on('close', (code) => {
                  if (code === 0) resolve();
                  else if (code === 1) {
                    // Merge conflict
                    conflictCount++;
                    reject(new Error('Merge conflict'));
                  } else {
                    reject(new Error(`git merge exited with code ${code}`));
                  }
                });
                proc.on('error', reject);
              });
              
              mergeCount++;
              if (!json) {
                console.log(`  ✅ Merged ${remoteBranch} into ${currentBranch}`);
              }
              results.push({ remote, status: 'merged', branch: currentBranch, remoteBranch });
            } catch (mergeErr) {
              if (mergeErr instanceof Error && mergeErr.message === 'Merge conflict') {
                if (!json) {
                  console.log(`  ⚠️  Merge conflict with ${remoteBranch} - resolve manually`);
                }
                results.push({ remote, status: 'conflict', branch: currentBranch, remoteBranch });
                conflictCount++;
              } else {
                throw mergeErr;
              }
            }
          } else if (rebase) {
            try {
              await new Promise((resolve, reject) => {
                const proc = spawn('git', ['rebase', remoteBranch], {
                  stdio: json ? 'pipe' : 'inherit',
                  encoding: 'utf-8'
                });
                proc.on('close', (code) => {
                  if (code === 0) resolve();
                  else if (code === 1) {
                    // Rebase conflict
                    conflictCount++;
                    reject(new Error('Rebase conflict'));
                  } else {
                    reject(new Error(`git rebase exited with code ${code}`));
                  }
                });
                proc.on('error', reject);
              });
              
              mergeCount++;
              if (!json) {
                console.log(`  ✅ Rebased ${currentBranch} onto ${remoteBranch}`);
              }
              results.push({ remote, status: 'rebased', branch: currentBranch, remoteBranch });
            } catch (rebaseErr) {
              if (rebaseErr instanceof Error && rebaseErr.message === 'Rebase conflict') {
                if (!json) {
                  console.log(`  ⚠️  Rebase conflict with ${remoteBranch} - resolve manually`);
                }
                results.push({ remote, status: 'conflict', branch: currentBranch, remoteBranch });
                conflictCount++;
              } else {
                throw rebaseErr;
              }
            }
          }
        } else {
          if (!json) {
            console.log(`  ℹ️  Remote branch ${remoteBranch} does not exist, skipping merge/rebase`);
          }
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        results.push({ remote, status: 'failed', error: errorMessage, branch: currentBranch });
        failCount++;
        
        if (!json) {
          console.error(`  ❌ Failed to process ${remote}: ${errorMessage}`);
        }
      }
    }
  } else if (dryRun && (merge || rebase)) {
    // Dry run mode - just show what would happen
    if (!json) {
      console.log('\n[DRY RUN] Would merge/rebase from the following remotes:');
      for (const remote of remotes) {
        const remoteBranch = `${remote}/${currentBranch}`;
        console.log(`  - ${remote}: ${remoteBranch}`);
      }
    }
  }
  
  if (json) {
    console.log(JSON.stringify({
      total: remotes.length,
      success: successCount,
      failed: failCount,
      merged: mergeCount,
      conflicts: conflictCount,
      branch: currentBranch,
      results
    }, null, 2));
  } else {
    console.log('\n' + '='.repeat(70));
    const summary = `Summary: ${successCount} succeeded, ${failCount} failed${merge || rebase ? `, ${mergeCount} merged/rebased` : ''}${conflictCount > 0 ? `, ${conflictCount} conflicts` : ''} out of ${remotes.length} remotes`;
    console.log(summary);
    console.log('='.repeat(70));
    
    if (conflictCount > 0) {
      console.log('\n⚠️  Conflicts detected:');
      results.filter(r => r.status === 'conflict').forEach(r => {
        console.log(`  ${r.remote}: ${r.remoteBranch} into ${r.branch}`);
      });
      console.log('\nResolve conflicts manually and commit to complete the merge/rebase.');
    }
    
    if (failCount > 0) {
      console.log('\nFailed remotes:');
      results.filter(r => r.status === 'failed').forEach(r => {
        console.log(`  ${r.remote}: ${r.error}`);
      });
      process.exit(1);
    }
  }
}
