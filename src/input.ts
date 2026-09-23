import { closeSync, openSync, readSync } from 'node:fs';
import { MAX_RECOVERY_REQUEST_BYTES } from './limits.js';

export function readRequest(file: string | number) {
  const descriptor = typeof file === 'number' ? file : openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(MAX_RECOVERY_REQUEST_BYTES + 1);
    let size = 0,
      count: number;
    while (
      size < bytes.length &&
      (count = readSync(descriptor, bytes, size, bytes.length - size, null)) > 0
    )
      size += count;
    if (size > MAX_RECOVERY_REQUEST_BYTES)
      throw new Error('Request too large. Send a smaller request.');
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)),
      ) as unknown;
    } catch {
      throw new Error('Request must be valid UTF-8 JSON.');
    }
  } finally {
    if (typeof file !== 'number') closeSync(descriptor);
  }
}
