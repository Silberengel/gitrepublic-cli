import { decode } from 'nostr-tools/nip19';
import { nip19 } from 'nostr-tools';
import { apiRequest } from '../utils/api.js';

/**
 * Repository operations command
 */
export async function repos(args, server, json) {
  const subcommand = args[0];
  
  if (subcommand === 'list') {
    // Get registered and unregistered repos from Nostr
    const listData = await apiRequest(server, '/repos/list', 'GET');
    
    // Get local repos (cloned on server)
    let localRepos = [];
    try {
      localRepos = await apiRequest(server, '/repos/local', 'GET');
    } catch (err) {
      // Local repos endpoint might not be available or might fail
      // Continue without local repos
    }
    
    // Helper function to check verification status
    async function checkVerification(npub, repoName) {
      try {
        // The verify endpoint doesn't require authentication, so we can call it directly
        const url = `${server.replace(/\/$/, '')}/api/repos/${npub}/${repoName}/verify`;
        const response = await fetch(url);
        if (!response.ok) {
          // If endpoint returns error, assume not verified
          return false;
        }
        const verifyData = await response.json();
        // Return true only if verified is explicitly true
        return verifyData.verified === true;
      } catch (err) {
        // Silently fail - assume not verified if check fails
        return false;
      }
    }
    
    // Check verification status for all repos (in parallel for performance)
    const registered = listData.registered || [];
    const verificationPromises = [];
    
    // Check verification for registered repos
    for (const repo of registered) {
      const name = repo.repoName || repo.name || 'unknown';
      const npub = repo.npub || 'unknown';
      if (name !== 'unknown' && npub !== 'unknown') {
        verificationPromises.push(
          checkVerification(npub, name).then(verified => ({ 
            key: `${npub}/${name}`, 
            verified 
          }))
        );
      }
    }
    
    // Check verification for local repos
    for (const repo of localRepos) {
      const name = repo.repoName || repo.name || 'unknown';
      const npub = repo.npub || 'unknown';
      if (name !== 'unknown' && npub !== 'unknown') {
        verificationPromises.push(
          checkVerification(npub, name).then(verified => ({ 
            key: `${npub}/${name}`, 
            verified 
          }))
        );
      }
    }
    
    // Wait for all verification checks to complete
    const verificationResults = await Promise.all(verificationPromises);
    const verifiedMap = new Map();
    verificationResults.forEach(result => {
      verifiedMap.set(result.key, result.verified);
    });
    
    if (json) {
      // Add verification status to JSON output
      const registeredWithVerification = registered.map(repo => ({
        ...repo,
        verified: verifiedMap.get(`${repo.npub}/${repo.repoName || repo.name || 'unknown'}`) || false
      }));
      const localWithVerification = localRepos.map(repo => ({
        ...repo,
        verified: verifiedMap.get(`${repo.npub}/${repo.repoName || repo.name || 'unknown'}`) || false
      }));
      
      console.log(JSON.stringify({
        registered: registeredWithVerification,
        local: localWithVerification,
        total: {
          registered: registered.length,
          local: localRepos.length,
          total: (registered.length + localRepos.length)
        }
      }, null, 2));
    } else {
      // Display help text explaining the difference
      console.log('Repository Types:');
      console.log('  Registered: Repositories announced on Nostr with this server in their clone URLs');
      console.log('  Local: Repositories cloned on this server (may be registered or unregistered)');
      console.log('  Verified: Repository ownership has been cryptographically verified');
      console.log('');
      
      // Display registered repositories
      if (registered.length > 0) {
        console.log('Registered Repositories:');
        registered.forEach(repo => {
          const name = repo.repoName || repo.name || 'unknown';
          const npub = repo.npub || 'unknown';
          const desc = repo.event?.tags?.find(t => t[0] === 'description')?.[1] || 
                      repo.description || 
                      'No description';
          const key = `${npub}/${name}`;
          const verified = verifiedMap.has(key) ? verifiedMap.get(key) : false;
          const verifiedStatus = verified ? 'verified' : 'unverified';
          console.log(`  ${npub}/${name} (${verifiedStatus}) - ${desc}`);
        });
        console.log('');
      }
      
      // Display local repositories
      if (localRepos.length > 0) {
        console.log('Local Repositories:');
        localRepos.forEach(repo => {
          const name = repo.repoName || repo.name || 'unknown';
          const npub = repo.npub || 'unknown';
          const desc = repo.announcement?.tags?.find(t => t[0] === 'description')?.[1] || 
                      repo.description || 
                      'No description';
          const registrationStatus = repo.isRegistered ? 'registered' : 'unregistered';
          const key = `${npub}/${name}`;
          // Get verification status - use has() to distinguish between false and undefined
          const verified = verifiedMap.has(key) ? verifiedMap.get(key) : false;
          const verifiedStatus = verified ? 'verified' : 'unverified';
          console.log(`  ${npub}/${name} (${registrationStatus}, ${verifiedStatus}) - ${desc}`);
        });
        console.log('');
      }
      
      // Summary
      const totalRegistered = registered.length;
      const totalLocal = localRepos.length;
      const totalVerified = Array.from(verifiedMap.values()).filter(v => v === true).length;
      if (totalRegistered === 0 && totalLocal === 0) {
        console.log('No repositories found.');
      } else {
        console.log(`Total: ${totalRegistered} registered, ${totalLocal} local, ${totalVerified} verified`);
      }
    }
  } else if (subcommand === 'get' && args[1]) {
    let npub, repo;
    
    // Check if first argument is naddr format
    if (args[1].startsWith('naddr1')) {
      try {
        const decoded = decode(args[1]);
        if (decoded.type === 'naddr') {
          const data = decoded.data;
          // naddr contains pubkey (hex) and identifier (d-tag)
          npub = nip19.npubEncode(data.pubkey);
          repo = data.identifier || data['d'];
          if (!repo) {
            throw new Error('Invalid naddr: missing identifier (d-tag)');
          }
        } else {
          throw new Error('Invalid naddr format');
        }
      } catch (err) {
        console.error(`Error: Failed to decode naddr: ${err.message}`);
        process.exit(1);
      }
    } else if (args[2]) {
      // Traditional npub/repo format
      [npub, repo] = args.slice(1);
    } else {
      console.error('Error: Invalid arguments. Use: repos get <npub> <repo> or repos get <naddr>');
      process.exit(1);
    }
    
    const data = await apiRequest(server, `/repos/${npub}/${repo}/settings`, 'GET');
    if (json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`Repository: ${npub}/${repo}`);
      console.log(`Description: ${data.description || 'No description'}`);
      console.log(`Private: ${data.private ? 'Yes' : 'No'}`);
      console.log(`Owner: ${data.owner || npub}`);
    }
  } else if (subcommand === 'settings' && args[1] && args[2]) {
    const [npub, repo] = args.slice(1);
    if (args[3]) {
      // Update settings
      const settings = {};
      for (let i = 3; i < args.length; i += 2) {
        const key = args[i].replace('--', '');
        const value = args[i + 1];
        if (key === 'description') settings.description = value;
        else if (key === 'private') settings.private = value === 'true';
      }
      const data = await apiRequest(server, `/repos/${npub}/${repo}/settings`, 'POST', settings);
      console.log(json ? JSON.stringify(data, null, 2) : 'Settings updated successfully');
    } else {
      // Get settings
      const data = await apiRequest(server, `/repos/${npub}/${repo}/settings`, 'GET');
      console.log(json ? JSON.stringify(data, null, 2) : JSON.stringify(data, null, 2));
    }
  } else if (subcommand === 'maintainers' && args[1] && args[2]) {
    const [npub, repo] = args.slice(1);
    const action = args[3];
    const maintainerNpub = args[4];
    
    if (action === 'add' && maintainerNpub) {
      const data = await apiRequest(server, `/repos/${npub}/${repo}/maintainers`, 'POST', { maintainer: maintainerNpub });
      console.log(json ? JSON.stringify(data, null, 2) : `Maintainer ${maintainerNpub} added successfully`);
    } else if (action === 'remove' && maintainerNpub) {
      const data = await apiRequest(server, `/repos/${npub}/${repo}/maintainers`, 'DELETE', { maintainer: maintainerNpub });
      console.log(json ? JSON.stringify(data, null, 2) : `Maintainer ${maintainerNpub} removed successfully`);
    } else {
      // List maintainers
      const data = await apiRequest(server, `/repos/${npub}/${repo}/maintainers`, 'GET');
      if (json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`Repository: ${npub}/${repo}`);
        console.log(`Owner: ${data.owner}`);
        console.log(`Maintainers: ${data.maintainers?.length || 0}`);
        if (data.maintainers?.length > 0) {
          data.maintainers.forEach(m => console.log(`  - ${m}`));
        }
      }
    }
  } else if (subcommand === 'branches' && args[1] && args[2]) {
    const [npub, repo] = args.slice(1);
    const data = await apiRequest(server, `/repos/${npub}/${repo}/branches`, 'GET');
    if (json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`Branches for ${npub}/${repo}:`);
      if (Array.isArray(data)) {
        data.forEach(branch => {
          console.log(`  ${branch.name} - ${branch.commit?.substring(0, 7) || 'N/A'}`);
        });
      }
    }
  } else if (subcommand === 'tags' && args[1] && args[2]) {
    const [npub, repo] = args.slice(1);
    const data = await apiRequest(server, `/repos/${npub}/${repo}/tags`, 'GET');
    if (json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`Tags for ${npub}/${repo}:`);
      if (Array.isArray(data)) {
        data.forEach(tag => {
          console.log(`  ${tag.name} - ${tag.hash?.substring(0, 7) || 'N/A'}`);
        });
      }
    }
  } else if (subcommand === 'fork' && args[1] && args[2]) {
    const [npub, repo] = args.slice(1);
    const data = await apiRequest(server, `/repos/${npub}/${repo}/fork`, 'POST', {});
    if (json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(`Repository forked successfully: ${data.npub}/${data.repo}`);
    }
  } else if (subcommand === 'delete' && args[1] && args[2]) {
    const [npub, repo] = args.slice(1);
    const data = await apiRequest(server, `/repos/${npub}/${repo}/delete`, 'DELETE');
    console.log(json ? JSON.stringify(data, null, 2) : 'Repository deleted successfully');
  } else {
    console.error('Invalid repos command. Use: list, get, settings, maintainers, branches, tags, fork, delete');
    process.exit(1);
  }
}
