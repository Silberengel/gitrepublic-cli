import { createNIP98Auth } from './auth.js';

/**
 * Make authenticated API request
 */
export async function apiRequest(server, endpoint, method = 'GET', body = null, options = {}) {
  const url = `${server.replace(/\/$/, '')}/api${endpoint}`;
  const authHeader = createNIP98Auth(url, method, body);

  const headers = {
    'Authorization': authHeader,
    'Content-Type': 'application/json'
  };

  const fetchOptions = {
    method,
    headers,
    ...options
  };

  if (body && method !== 'GET') {
    fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const response = await fetch(url, fetchOptions);
  const text = await response.text();
  
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    // Sanitize error message to prevent key leaks
    const { sanitizeErrorMessage } = await import('./error-sanitizer.js');
    const errorData = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
    const sanitizedData = sanitizeErrorMessage(errorData);
    throw new Error(`API request failed: ${response.status} ${response.statusText}\n${sanitizedData}`);
  }

  return data;
}
