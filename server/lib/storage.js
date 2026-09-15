// Where uploaded evidence actually lives: the local disk, under server/uploads.
//
// There is deliberately no remote store, so the whole system runs on one machine
// with no external service. A deployment therefore needs a
// disk that survives restarts (and is backed up) -- a serverless function has
// none, so uploads cannot work there. The routes above this file only ever call
// saveFile/readFile/deleteFile, so a different store would slot in here alone.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// UPLOADS_DIR points it at a mounted disk on a host whose code folder is replaced
// on every deploy (Render mounts one at /var/data/uploads). Left unset, files go
// under server/uploads beside the code, as on an ordinary server.
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

export async function saveFile(folder, storedName, buffer) {
  await fs.promises.writeFile(path.join(diskFolder(folder), path.basename(storedName)), buffer);
}

// Returns null when the record points at a file that is no longer there, which
// the caller reports as a 404 rather than a server error.
export async function readFile(folder, storedName) {
  const absolute = path.join(diskRoot, folder, path.basename(storedName));
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

// Deleting evidence is already recorded in the audit trail, so a failure to
// remove the bytes must not fail the request that recorded the removal.
export async function deleteFile(folder, storedName) {
  try {
    await fs.promises.unlink(path.join(diskRoot, folder, path.basename(storedName)));
  } catch {
    // Left in place deliberately; the database row is already gone.
  }
}
