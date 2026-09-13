import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createSessionStore, WorkbenchError } from './sessions';

type Store = ReturnType<typeof createSessionStore>;
type Operation = 'list' | 'read' | 'create' | 'recordAttempt' | 'addCapture' | 'remove' | 'captureCapacity';
const operations: Operation[] = ['list', 'read', 'create', 'recordAttempt', 'addCapture', 'remove', 'captureCapacity'];

if (!isMainThread && workerData?.kind === 'aircraft-support-storage') {
  const store = createSessionStore(workerData.root);
  parentPort!.on('message', ({ id, operation, args }) => {
    try {
      if (!operations.includes(operation)) throw new WorkbenchError('Unknown storage operation.');
      const value = (store[operation] as (..._args: any[]) => any)(...args);
      parentPort!.postMessage({ id, value });
    } catch (error) {
      if (!(error instanceof WorkbenchError)) console.error('[aircraft-support storage]', error);
      parentPort!.postMessage({ id, error: error instanceof WorkbenchError ? error.message
        : 'Saved files could not be accessed. Check disk space and folder permissions.',
      status: error instanceof WorkbenchError ? error.status : 500 });
    }
  });
}

export function createSessionWorker(root: string) {
  const worker = new Worker(__filename, { workerData: { kind: 'aircraft-support-storage', root } });
  let sequence = 0;
  let failure: Error | null = null;
  const pending = new Map<number, { resolve: (_value: any) => void; reject: (_error: Error) => void }>();
  worker.on('message', message => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new WorkbenchError(message.error, message.status));
    else request.resolve(message.value);
  });
  function fail(error: Error) {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  worker.on('error', () => fail(new WorkbenchError('Saved-file storage stopped. Restart Flight Fabric to reconnect.', 503)));
  worker.on('exit', () => fail(new WorkbenchError('Saved-file storage is closed.', 503)));
  function call<K extends Operation>(operation: K, ...args: Parameters<Store[K]>): Promise<ReturnType<Store[K]>> {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, operation, args }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  async function close() {
    fail(new WorkbenchError('Saved-file storage is closed.', 503));
    await worker.terminate();
  }
  return { call, close };
}
