'use strict';

const { parentPort, workerData } = require('node:worker_threads') as typeof import('node:worker_threads');
const timelineGenerator = require('./timeline-generator') as {
  _generateFromCSVInProcess: (
    _csvPath: string,
    _options?: Record<string, any>,
  ) => Promise<
    | { success: false; error: string }
    | { success: true; timeline: Record<string, any> }
  >;
};

async function main() {
  if (!parentPort) return;

  try {
    const csvPath = typeof workerData?.csvPath === 'string' ? workerData.csvPath : '';
    const options = (
      workerData?.options
      && typeof workerData.options === 'object'
      && !Array.isArray(workerData.options)
    )
      ? workerData.options
      : {};
    if (!csvPath) {
      parentPort.postMessage({ success: false, error: 'Timeline worker received an invalid request.' });
      return;
    }

    const result = await timelineGenerator._generateFromCSVInProcess(csvPath, options);
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
