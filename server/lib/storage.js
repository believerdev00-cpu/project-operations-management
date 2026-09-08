// Where uploaded evidence actually lives.
//
// On an ordinary server that is the local disk, and that is what development
// uses -- nothing about running this project locally changes. A serverless host
// has no disk that survives a request, so when SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are set the same files go to Supabase Storage
// instead. The routes above this file never learn which of the two it is.
//
// Supabase Storage is reached over its REST API rather than the client library,
// because Node has had fetch built in since 18 and one fewer dependency in a
// serverless bundle is worth having.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'evidence';

// The service role key bypasses row level security, so it must never reach the
// browser. It is only ever read here, in server code.
export const usingRemoteStorage = Boolean(supabaseUrl && serviceKey);

const diskRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads');

// Creating the directory at import time is right for a server and fatal on a
// read-only filesystem, so it only happens when the disk is actually the store.
function diskFolder(folder) {
  const target = path.join(diskRoot, folder);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

// A stored name is never taken from the upload: an attacker-chosen filename is
// how a path traversal gets in. Only the extension is carried over, stripped of
// anything that is not a plain character.
export function storedFileName(originalName) {
  const extension = path.extname(String(originalName || '')).toLowerCase().slice(0, 10);
  return `${crypto.randomUUID()}${extension.replace(/[^a-z0-9.]/g, '')}`;
}

function objectUrl(folder, storedName) {
  return `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeURIComponent(folder)}/${encodeURIComponent(storedName)}`;
}

export async function saveFile(folder, storedName, buffer, mimeType) {
  if (!usingRemoteStorage) {
    await fs.promises.writeFile(path.join(diskFolder(folder), path.basename(storedName)), buffer);
    return;
  }
  const response = await fetch(objectUrl(folder, storedName), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': mimeType || 'application/octet-stream',
      'cache-control': 'max-age=3600'
    },
    body: buffer
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`The file could not be stored (${response.status}). ${detail.slice(0, 200)}`);
  }
}

// Returns null when the record points at a file that is no longer there, which
// the caller reports as a 404 rather than a server error.
export async function readFile(folder, storedName) {
  if (!usingRemoteStorage) {
    const absolute = path.join(diskRoot, folder, path.basename(storedName));
    if (!fs.existsSync(absolute)) return null;
    return fs.createReadStream(absolute);
  }
  const response = await fetch(objectUrl(folder, storedName), {
    headers: { Authorization: `Bearer ${serviceKey}` }
  });
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
}

// Deleting evidence is already recorded in the audit trail, so a failure to
// remove the bytes must not fail the request that recorded the removal.
export async function deleteFile(folder, storedName) {
  try {
    if (!usingRemoteStorage) {
      await fs.promises.unlink(path.join(diskRoot, folder, path.basename(storedName)));
      return;
    }
    await fetch(objectUrl(folder, storedName), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${serviceKey}` }
    });
  } catch {
    // Left in place deliberately; the database row is already gone.
  }
}
