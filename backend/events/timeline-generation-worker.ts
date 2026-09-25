'use strict';
import type { RecordingReadRequest, RecordingReadResult } from './timeline-generator';

const { parentPort, workerData } = require('node:worker_threads') as typeof import('node:worker_threads');
const timelineGenerator = require('./timeline-generator') as {
  processRecordingInProcess: (
    _csvPath: string,
    _request: RecordingReadRequest,
  ) => Promise<RecordingReadResult>;
};

async function main() {
  if (!parentPort) return;

  try {
    const csvPath = typeof workerData?.csvPath === 'string' ? workerData.csvPath : '';
    const request = workerData?.request;
    const validRequest = request?.kind === 'timeline'
      ? request.options && typeof request.options === 'object' && !Array.isArray(request.options)
      : request?.kind === 'replay-clip' && Number.isSafeInteger(request.landingIndex) && request.landingIndex >= 0;
    if (!csvPath || !validRequest) {
      parentPort.postMessage({ success: false, error: 'Timeline worker received an invalid request.' });
      return;
    }

    const result = await timelineGenerator.processRecordingInProcess(csvPath, request);
    parentPort.postMessage(result);
  } catch {
    parentPort.postMessage({
      success: false,
      error: 'Timeline processing stopped safely because the recording could not be processed.',
    });
  } finally {
    parentPort.close();
  }
}

void main();

export {};
