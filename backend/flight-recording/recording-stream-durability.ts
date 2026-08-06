'use strict';

const fs = require('fs') as typeof import('fs');

type FsWriteStream = import('fs').WriteStream & { fd?: number | null };

function waitForBufferedWrites(stream: FsWriteStream): Promise<void> {
  if (stream.destroyed || stream.closed) {
    return Promise.reject(new Error('Recording stream is already closed'));
  }
  return new Promise((resolve, reject) => {
    stream.write('', (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function syncStreamFd(stream: FsWriteStream): Promise<void> {
  const fd = stream.fd;
  if (typeof fd !== 'number') {
    return Promise.reject(new Error('Recording stream file descriptor is unavailable'));
  }
  return new Promise((resolve, reject) => {
    fs.fdatasync(fd, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function flushWriteStreamDurably(stream: FsWriteStream): Promise<void> {
  await waitForBufferedWrites(stream);
  await syncStreamFd(stream);
}

async function closeWriteStreamDurably(stream: FsWriteStream): Promise<void> {
  let syncError: unknown = null;
  try {
    await flushWriteStreamDurably(stream);
  } catch (error) {
    syncError = error;
  }

  let closeError: unknown = null;
  if (!stream.closed) {
    await new Promise<void>((resolve) => {
      let settled = false;
      const onClose = () => {
        if (settled) return;
        settled = true;
        stream.off('error', onError);
        resolve();
      };
      const onError = (error: Error) => {
        closeError ||= error;
        // Do not resolve on `error`: fd ownership is retained until `close`.
      };
      stream.once('close', onClose);
      stream.on('error', onError);
      try {
        stream.end();
      } catch (error) {
        closeError ||= error;
        try { stream.destroy(error as Error); } catch {}
      }
      if (stream.closed) onClose();
    });
  }

  if (syncError) throw syncError;
  if (closeError) throw closeError;
}

module.exports = {
  closeWriteStreamDurably,
  flushWriteStreamDurably,
};

export {};
