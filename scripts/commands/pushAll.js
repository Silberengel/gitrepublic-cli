// Note: Using spawn instead of execSync for security (prevents command injection)

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
      // If we can't convert, assume reachable (will fail on actual push if not)
      return { reachable: true, error: undefined };
    }
  }
  
  try {
    // Parse URL and construct test endpoint
    const urlObj = new URL(testUrl);
    
    // Only test HTTP/HTTPS URLs
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      // For other protocols (like git://), assume reachable
      return { reachable: true, error: undefined };
    }
    
    const infoRefsUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}/info/refs?service=git-upload-pack`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
      const response = await fetch(infoRefsUrl, {
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
    // For SSH URLs that we couldn't convert, assume reachable (will fail on actual push if not)
    if (isSshUrl(url)) {
      return { reachable: true, error: undefined };
    }
    return { reachable: false, error: urlError instanceof Error ? urlError.message : 'Invalid URL' };
  }
}

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
 * Push to all remotes
 * Security: Uses spawn with argument arrays to prevent command injection
 * 
 * Checks reachability of each remote before pushing, skipping unreachable ones.
 * This allows skipping GRASP servers that aren't reachable or public.
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
  --skip-reachability        Skip reachability check (push to all remotes regardless)
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
  - Checks reachability of each remote before pushing (skips unreachable ones)
  - If any reachable remote fails, the command will exit with an error code
  - Use --dry-run to test before actually pushing
`);
    return;
  }
  
  // Parse arguments
  const branch = args.find(arg => !arg.startsWith('--'));
  const force = args.includes('--force') || args.includes('-f');
  const tags = args.includes('--tags');
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  const skipReachabilityCheck = args.includes('--skip-reachability');
  
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
          console.log(`  ⚠️  ${remote} - Could not check reachability, will attempt push`);
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
  
  if (unreachableRemotes.length > 0 && !json) {
    console.log(`\n⚠️  Skipping ${unreachableRemotes.length} unreachable remote(s):`);
    unreachableRemotes.forEach(info => {
      console.log(`  - ${info.remote} (${info.url}): ${info.error || 'Unreachable'}`);
    });
  }
  
  if (reachableRemotes.length === 0) {
    console.error('Error: No reachable remotes found');
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
  let skippedCount = unreachableRemotes.length;
  
  for (const remoteInfo of reachableRemotes) {
    const remote = remoteInfo.remote;
    try {
      if (!json && !dryRun) {
        console.log(`\nPushing to ${remote}...`);
      }
      
      // Security: Use spawn with argument arrays to prevent command injection
      const { spawn } = await import('child_process');
      const command = ['push', remote, ...pushArgs];
      
      await new Promise((resolve, reject) => {
        const proc = spawn('git', command, {
          stdio: json ? 'pipe' : 'inherit',
          encoding: 'utf-8'
        });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`git push exited with code ${code}`));
        });
        proc.on('error', reject);
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
  
  // Add skipped remotes to results
  unreachableRemotes.forEach(info => {
    results.push({ 
      remote: info.remote, 
      status: 'skipped', 
      error: info.error || 'Unreachable',
      url: info.url
    });
  });
  
  if (json) {
    console.log(JSON.stringify({
      total: remotes.length,
      reachable: reachableRemotes.length,
      skipped: skippedCount,
      success: successCount,
      failed: failCount,
      results
    }, null, 2));
  } else {
    console.log('\n' + '='.repeat(70));
    const summary = `Push Summary: ${successCount} succeeded, ${failCount} failed, ${skippedCount} skipped out of ${remotes.length} remotes`;
    console.log(summary);
    console.log('='.repeat(70));
    
    if (skippedCount > 0) {
      console.log('\nSkipped remotes (unreachable):');
      unreachableRemotes.forEach(info => {
        console.log(`  ${info.remote} (${info.url}): ${info.error || 'Unreachable'}`);
      });
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
