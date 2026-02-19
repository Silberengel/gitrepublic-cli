import { readFileSync } from 'fs';
import { apiRequest } from '../utils/api.js';

/**
 * File operations command
 */
export async function file(args, server, json) {
  const subcommand = args[0];
  
  if (subcommand === 'get' && args[1] && args[2] && args[3]) {
    const [npub, repo, path] = args.slice(1);
    const branch = args[4] || 'main';
    const data = await apiRequest(server, `/repos/${npub}/${repo}/file?path=${encodeURIComponent(path)}&branch=${branch}`, 'GET');
    if (json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(data.content || data);
    }
  } else if (subcommand === 'put' && args[1] && args[2] && args[3]) {
    const [npub, repo, path] = args.slice(1);
    let content;
    if (args[4]) {
      // Read from file
      try {
        content = readFileSync(args[4], 'utf-8');
      } catch (error) {
        throw new Error(`Failed to read file ${args[4]}: ${error.message}`);
      }
    } else {
      // Read from stdin
      const chunks = [];
      process.stdin.setEncoding('utf8');
      return new Promise((resolve, reject) => {
        process.stdin.on('readable', () => {
          let chunk;
          while ((chunk = process.stdin.read()) !== null) {
            chunks.push(chunk);
          }
        });
        process.stdin.on('end', async () => {
          content = chunks.join('');
          const commitMessage = args[5] || 'Update file';
          const branch = args[6] || 'main';
          
          try {
            const data = await apiRequest(server, `/repos/${npub}/${repo}/file`, 'POST', {
              path,
              content,
              commitMessage,
              branch,
              action: 'write'
            });
            console.log(json ? JSON.stringify(data, null, 2) : 'File updated successfully');
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
    }
    const commitMessage = args[5] || 'Update file';
    const branch = args[6] || 'main';
    
    const data = await apiRequest(server, `/repos/${npub}/${repo}/file`, 'POST', {
      path,
      content,
      commitMessage,
      branch,
      action: 'write'
    });
    console.log(json ? JSON.stringify(data, null, 2) : 'File updated successfully');
  } else if (subcommand === 'delete' && args[1] && args[2] && args[3]) {
    const [npub, repo, path] = args.slice(1);
    const commitMessage = args[4] || `Delete ${path}`;
    const branch = args[5] || 'main';
    
    const data = await apiRequest(server, `/repos/${npub}/${repo}/file`, 'POST', {
      path,
      commitMessage,
      branch,
      action: 'delete'
    });
    console.log(json ? JSON.stringify(data, null, 2) : 'File deleted successfully');
  } else {
    console.error('Invalid file command. Use: get <npub> <repo> <path> [branch], put <npub> <repo> <path> [file] [message] [branch], delete <npub> <repo> <path> [message] [branch]');
    process.exit(1);
  }
}
