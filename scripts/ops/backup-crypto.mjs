#!/usr/bin/env node
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, link, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('WCTMBACKUPAESG1\n', 'ascii');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

async function loadKey(path) {
  const details = await stat(path);
  if (!details.isFile() || (details.mode & 0o077) !== 0) {
    throw new Error('backup encryption key must be a private regular file');
  }
  const material = await readFile(path);
  if (material.length !== 32) {
    throw new Error('backup encryption key must contain exactly 32 bytes');
  }
  return Buffer.from(
    hkdfSync('sha256', material, 'WCTM backup v1', 'off-site database dump', 32)
  );
}

async function transform(mode, keyFile, input, output) {
  if (input === output) {
    throw new Error('backup input and output must differ');
  }
  const key = await loadKey(keyFile);
  const temporary = `${output}.partial-${process.pid}`;
  let committed = false;

  try {
    if (mode === 'encrypt') {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(MAGIC);
      await writeFile(temporary, Buffer.concat([MAGIC, nonce]), {
        flag: 'wx',
        mode: 0o600,
      });
      await pipeline(
        createReadStream(input),
        cipher,
        createWriteStream(temporary, { flags: 'a', mode: 0o600 })
      );
      await appendFile(temporary, cipher.getAuthTag());
    } else if (mode === 'decrypt') {
      const details = await stat(input);
      const minimum = MAGIC.length + NONCE_BYTES + TAG_BYTES;
      if (!details.isFile() || details.size < minimum) {
        throw new Error('encrypted backup format is invalid');
      }
      const handle = await open(input, 'r');
      const header = Buffer.alloc(MAGIC.length + NONCE_BYTES);
      const tag = Buffer.alloc(TAG_BYTES);
      try {
        await handle.read(header, 0, header.length, 0);
        await handle.read(tag, 0, tag.length, details.size - TAG_BYTES);
      } finally {
        await handle.close();
      }
      if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error('encrypted backup format is invalid');
      }
      const nonce = header.subarray(MAGIC.length);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(MAGIC);
      decipher.setAuthTag(tag);
      await pipeline(
        createReadStream(input, {
          start: MAGIC.length + NONCE_BYTES,
          end: details.size - TAG_BYTES - 1,
        }),
        decipher,
        createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
      );
    } else {
      throw new Error('expected encrypt or decrypt');
    }
    await link(temporary, output);
    await rm(temporary);
    committed = true;
  } finally {
    key.fill(0);
    if (!committed) {
      await rm(temporary, { force: true });
    }
  }
}

if (process.argv.length !== 6) {
  process.stderr.write('usage: backup-crypto.mjs encrypt|decrypt KEY_FILE INPUT OUTPUT\n');
  process.exitCode = 64;
} else {
  transform(...process.argv.slice(2)).catch(() => {
    process.stderr.write('backup encryption/decryption failed; check protected key and input\n');
    process.exitCode = 1;
  });
}
