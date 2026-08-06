'use strict';

const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const { TextDecoder } = require('node:util') as typeof import('node:util');

type RecordMode = 'csv' | 'line';

type RecordMetadata = {
  recordNumber: number;
  terminated: boolean;
};

type StreamUtf8RecordsOptions = {
  expectedStat: import('node:fs').BigIntStats;
  filePath: string;
  label: string;
  maxBytes: number;
  maxRecordChars: number;
  mode: RecordMode;
  onRecord: (_record: string, _metadata: RecordMetadata) => void;
};

type StreamUtf8RecordsResult = {
  fileSizeBytes: number;
  recordCount: number;
  sha256: string;
};

const READ_CHUNK_BYTES = 64 * 1024;

function createReadError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/**
 * Read a bounded UTF-8 file without ever materializing the whole byte buffer,
 * decoded document, or split-record array. The caller still decides what
 * records must be retained.
 *
 * CSV mode understands quoted newlines and escaped quotes. It deliberately
 * leaves syntax policy to the CSV parser; its only job is finding safe logical
 * record boundaries.
 */
async function streamUtf8Records(
  options: StreamUtf8RecordsOptions,
): Promise<StreamUtf8RecordsResult> {
  const {
    expectedStat,
    filePath,
    label,
    maxBytes,
    maxRecordChars,
    mode,
    onRecord,
  } = options;

  if (expectedStat.size > BigInt(maxBytes)) {
    throw createReadError('FF_FILE_TOO_LARGE', `${label} exceeds its safe read limit`);
  }

  const handle = await fs.promises.open(filePath, 'r');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const digest = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const recordParts: string[] = [];
  let recordChars = 0;
  let recordCount = 0;
  let position = 0;
  let skipLeadingLf = false;
  let csvState: 'start' | 'unquoted' | 'quoted' | 'after_quote' | 'invalid' = 'start';

  const append = (part: string) => {
    if (!part) return;
    recordChars += part.length;
    if (recordChars > maxRecordChars) {
      throw createReadError(
        'FF_RECORD_TOO_LARGE',
        `${label} contains a record larger than its safe processing limit`,
      );
    }
    recordParts.push(part);
  };

  const emit = (terminated: boolean) => {
    recordCount += 1;
    onRecord(recordParts.join(''), { recordNumber: recordCount, terminated });
    recordParts.length = 0;
    recordChars = 0;
    csvState = 'start';
  };

  const consume = (text: string) => {
    let segmentStart = 0;
    if (skipLeadingLf) {
      skipLeadingLf = false;
      if (text[0] === '\n') segmentStart = 1;
    }

    for (let index = segmentStart; index < text.length; index += 1) {
      const char = text[index];
      const isRecordDelimiter = char === '\n' || char === '\r';
      const insideQuotedCsv = mode === 'csv' && csvState === 'quoted';

      if (isRecordDelimiter && !insideQuotedCsv) {
        append(text.slice(segmentStart, index));
        emit(true);
        if (char === '\r') {
          if (text[index + 1] === '\n') index += 1;
          else if (index === text.length - 1) skipLeadingLf = true;
        }
        segmentStart = index + 1;
        continue;
      }

      if (mode !== 'csv') continue;

      if (csvState === 'start') {
        if (char === '"') csvState = 'quoted';
        else if (char !== ',') csvState = 'unquoted';
      } else if (csvState === 'unquoted') {
        if (char === ',') csvState = 'start';
        else if (char === '"') csvState = 'invalid';
      } else if (csvState === 'quoted') {
        if (char === '"') csvState = 'after_quote';
      } else if (csvState === 'after_quote') {
        if (char === '"') csvState = 'quoted';
        else if (char === ',') csvState = 'start';
        else if (!isRecordDelimiter) csvState = 'invalid';
      }
    }

    append(text.slice(segmentStart));
  };

  try {
    const openedStat = await handle.stat({ bigint: true });
    if (
      !openedStat.isFile()
      || openedStat.dev !== expectedStat.dev
      || openedStat.ino !== expectedStat.ino
    ) {
      throw createReadError('FF_FILE_CHANGED_ON_OPEN', `${label} changed while it was being opened`);
    }
    if (openedStat.size > BigInt(maxBytes)) {
      throw createReadError('FF_FILE_TOO_LARGE', `${label} exceeds its safe read limit`);
    }

    const expectedBytes = Number(openedStat.size);
    while (position < expectedBytes) {
      const requested = Math.min(buffer.length, expectedBytes - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead <= 0) {
        throw createReadError('FF_FILE_CHANGED_DURING_READ', `${label} changed while it was being read`);
      }
      const chunk = buffer.subarray(0, bytesRead);
      position += bytesRead;
      digest.update(chunk);
      let decoded: string;
      try {
        decoded = decoder.decode(chunk, { stream: true });
      } catch {
        throw createReadError('FF_INVALID_UTF8', `${label} contains invalid UTF-8`);
      }
      consume(decoded);
    }

    let decodedTail: string;
    try {
      decodedTail = decoder.decode();
    } catch {
      throw createReadError('FF_INVALID_UTF8', `${label} contains invalid UTF-8`);
    }
    consume(decodedTail);

    const finalStat = await handle.stat({ bigint: true });
    if (
      finalStat.dev !== openedStat.dev
      || finalStat.ino !== openedStat.ino
      || finalStat.size !== openedStat.size
      || position !== expectedBytes
    ) {
      throw createReadError('FF_FILE_CHANGED_DURING_READ', `${label} changed while it was being read`);
    }

    if (recordChars > 0) emit(false);

    return {
      fileSizeBytes: position,
      recordCount,
      sha256: digest.digest('hex'),
    };
  } finally {
    await handle.close();
  }
}

module.exports = {
  streamUtf8Records,
};

export {};
