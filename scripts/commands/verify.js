import { readFileSync, existsSync } from 'fs';
import { verifyEvent, getEventHash } from 'nostr-tools';

/**
 * Verify a Nostr event signature and ID
 */
export async function verify(args, server, json) {
  const input = args[0];
  if (!input) {
    console.error('Error: Event file path or JSON required');
    console.error('Use: verify <event-file.jsonl> or verify <event-json>');
    process.exit(1);
  }

  let event;
  try {
    // Try to read as file first
    if (existsSync(input)) {
      const content = readFileSync(input, 'utf-8').trim();
      // If it's JSONL, get the last line (most recent event)
      const lines = content.split('\n').filter(l => l.trim());
      const lastLine = lines[lines.length - 1];
      event = JSON.parse(lastLine);
    } else {
      // Try to parse as JSON directly
      event = JSON.parse(input);
    }
  } catch (err) {
    console.error(`Error: Failed to parse event: ${err instanceof Error ? err.message : 'Unknown error'}`);
    process.exit(1);
  }

  // Verify event
  const signatureValid = verifyEvent(event);
  const computedId = getEventHash(event);
  const idMatches = event.id === computedId;

  if (json) {
    console.log(JSON.stringify({
      valid: signatureValid && idMatches,
      signatureValid,
      idMatches,
      computedId,
      eventId: event.id,
      kind: event.kind,
      pubkey: event.pubkey,
      created_at: event.created_at,
      timestamp: new Date(event.created_at * 1000).toLocaleString(),
      timestamp_utc: new Date(event.created_at * 1000).toISOString()
    }, null, 2));
  } else {
    console.log('Event Verification:');
    console.log(`  Kind: ${event.kind}`);
    console.log(`  Pubkey: ${event.pubkey.substring(0, 16)}...`);
    console.log(`  Created: ${new Date(event.created_at * 1000).toLocaleString()}`);
    console.log(`  Event ID: ${event.id.substring(0, 16)}...`);
    console.log('');
    console.log('Verification Results:');
    console.log(`  Signature valid: ${signatureValid ? '✅ Yes' : '❌ No'}`);
    console.log(`  Event ID matches: ${idMatches ? '✅ Yes' : '❌ No'}`);
    if (!idMatches) {
      console.log(`  Computed ID: ${computedId}`);
      console.log(`  Expected ID: ${event.id}`);
    }
    console.log('');
    
    if (signatureValid && idMatches) {
      console.log('✅ Event is VALID');
    } else {
      console.log('❌ Event is INVALID');
      if (!signatureValid) {
        console.log('  - Signature verification failed');
      }
      if (!idMatches) {
        console.log('  - Event ID does not match computed hash');
      }
      process.exit(1);
    }
  }
}
