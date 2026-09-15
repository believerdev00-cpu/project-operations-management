// Where uploaded evidence actually lives.
//
// Two stores, chosen by the environment and nothing else. The routes above this
// file only ever call saveFile / readFile / deleteFile, so neither they nor the
// database know which one is in use:
//
//   * a folder on disk -- server/uploads, or UPLOADS_DIR -- which is what an
//     ordinary server and this project's own machine use. Files sit behind the
//     permission-checked routes and are reachable no other way.
//
//   * Vercel Blob, when BLOB_READ_WRITE_TOKEN is set, because a serverless host
//     has no disk that survives a request. Blob objects live at long random
//     addresses that this app never hands out -- every read still goes through
//     the permission-checked route, which fetches the bytes itself -- but they
//     are not themselves permission-checked, so a leaked address is readable.
//     That is the trade for running without a disk.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Vercel caps a request body at 4.5 MB, and every upload goes through the API
// so the record can be authorised before a byte is stored. The limit is the
// same everywhere, so a photo that uploads on one deployment uploads on all.
export const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
export const MAX_EVIDENCE_FILES = 10;
export const MAX_EVIDENCE_LABEL = '4 MB';

const blobToken = process.env.BLOB_READ_WRITE_TOKEN || '';
export const usingBlobStore = Boolean(blobToken);
const BLOB_API = 'https://blob.vercel-storage.com';
const BLOB_API_VERSION = '7';

// UPLOADS_DIR points it at a mounted disk on a host whose code folder is replaced
// on every deploy. Left unset, files go under server/uploads beside the code.
const diskRoot = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'uploads');

// Created on first write rather than at import time, so merely loading the API
// on a read-only filesystem does not crash it.
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

// ---- Vercel Blob ------------------------------------------------------------

// The store's public host, learned from the first upload or listing and kept
// for the life of the process. The database stores only the file's name, as it
// does for the disk, so the address is rebuilt from that.
let blobBase = '';

function blobHeaders(extra = {}) {
  return { authorization: `Bearer ${blobToken}`, 'x-api-version': BLOB_API_VERSION, ...extra };
}

async function blobFailed(response, what) {
  const detail = await response.text().catch(() => '');
  throw new Error(`Blob storage ${what} failed (${response.status}). ${detail.slice(0, 200)}`);
}

// The address of a file already stored. After a cold start the host is unknown,
// so it is looked up once from the store's own listing.
async function blobUrl(pathname) {
  if (!blobBase) {
    const response = await fetch(`${BLOB_API}?prefix=${encodeURIComponent(pathname)}&limit=1`, { headers: blobHeaders() });
    if (!response.ok) await blobFailed(response, 'lookup');
    const found = (await response.json())?.blobs?.[0];
    if (!found?.url) return null;
    blobBase = new URL(found.url).origin;
    return found.url;
  }
  return `${blobBase}/${pathname.split('/').map(encodeURIComponent).join('/')}`;
}

// ---- the three operations the routes use ------------------------------------

export async function saveFile(folder, storedName, buffer) {
  const name = path.basename(storedName);
  if (!usingBlobStore) {
    await fs.promises.writeFile(path.join(diskFolder(folder), name), buffer);
    return;
  }
  const response = await fetch(`${BLOB_API}/${folder}/${name}`, {
    method: 'PUT',
    headers: blobHeaders({
      // The name is already a random UUID, so a second random suffix would only
      // make the stored name differ from the one in the database.
      'x-add-random-suffix': '0',
      // Evidence is private and permission-checked on every read, so no cache
      // may keep a copy that outlives the check.
      'x-cache-control-max-age': '0'
    }),
    body: buffer
  });
  if (!response.ok) await blobFailed(response, 'upload');
  const saved = await response.json().catch(() => ({}));
  if (saved.url) blobBase = new URL(saved.url).origin;
}

// Returns null when the record points at a file that is no longer there, which
// the caller reports as a 404 rather than a server error. The disk hands back a
// stream; Blob hands back a buffer already in hand.
export async function readFile(folder, storedName) {
  const name = path.basename(storedName);
  if (!usingBlobStore) {
    const absolute = path.join(diskRoot, folder, name);
    // Opened first and only then handed back, so a file deleted between a check
    // and the open is a 404 here -- a stream erroring with no listener attached
    // is an uncaught exception that takes the whole API down.
    try {
      await fs.promises.access(absolute, fs.constants.R_OK);
    } catch {
      return null;
    }
    const stream = fs.createReadStream(absolute);
    stream.on('error', (error) => {
      console.error('Evidence read failed:', error.message);
      stream.destroy();
    });
    return stream;
  }
  const url = await blobUrl(`${folder}/${name}`);
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
}

// Deleting evidence is already recorded in the audit trail, so a failure to
// remove the bytes must not fail the request that recorded the removal.
export async function deleteFile(folder, storedName) {
  const name = path.basename(storedName);
  try {
    if (!usingBlobStore) {
      await fs.promises.unlink(path.join(diskRoot, folder, name));
      return;
    }
    const url = await blobUrl(`${folder}/${name}`);
    if (!url) return;
    await fetch(`${BLOB_API}/delete`, {
      method: 'POST',
      headers: blobHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ urls: [url] })
    });
  } catch (error) {
    // Left in place deliberately; the database row is already gone.
    console.warn('Evidence file could not be removed:', error.message);
  }
}
