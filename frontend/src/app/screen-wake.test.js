import test from 'node:test';
import assert from 'node:assert/strict';
import { initScreenWakeRuntime } from './screen-wake.js';

function createEventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, handler, options) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ handler, options });
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) || [];
      listeners.set(type, list.filter((entry) => entry.handler !== handler));
    },
    dispatch(type) {
      (listeners.get(type) || []).slice().forEach((entry) => entry.handler({ type }));
    },
    count(type) {
      return (listeners.get(type) || []).length;
    },
  };
}

function createDocument() {
  return Object.assign(createEventTarget(), { visibilityState: 'visible' });
}

function createNoSleepStub({ fail = 0 } = {}) {
  const stub = {
    enableCalls: 0,
    disableCalls: 0,
    remainingFailures: fail,
    enable() {
      stub.enableCalls += 1;
      if (stub.remainingFailures > 0) {
        stub.remainingFailures -= 1;
        return Promise.reject(new Error('NotAllowedError'));
      }
      return Promise.resolve();
    },
    disable() {
      stub.disableCalls += 1;
    },
  };
  return stub;
}

const silentLog = { warn() {} };

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('the desktop page never constructs NoSleep or listens for taps', () => {
  const documentRef = createDocument();
  let constructed = 0;
  const cleanup = initScreenWakeRuntime({
    windowRef: { location: { pathname: '/' } },
    documentRef,
    navigatorRef: {},
    createNoSleep: () => { constructed += 1; return createNoSleepStub(); },
    log: silentLog,
  });
  assert.equal(constructed, 0);
  assert.equal(documentRef.count('click'), 0);
  assert.equal(documentRef.count('visibilitychange'), 0);
  cleanup();
});

test('the phone page takes the lock on the first tap and stops listening', async () => {
  const documentRef = createDocument();
  const noSleep = createNoSleepStub();
  const cleanup = initScreenWakeRuntime({
    windowRef: { location: { pathname: '/remote' } },
    documentRef,
    navigatorRef: { wakeLock: {} },
    createNoSleep: () => noSleep,
    log: silentLog,
  });

  assert.equal(noSleep.enableCalls, 0, 'nothing is requested before a gesture');
  assert.equal(documentRef.count('click'), 1);
  assert.equal(documentRef.count('touchend'), 1);
  assert.equal(documentRef.count('keydown'), 1);

  documentRef.dispatch('touchend');
  await settle();
  assert.equal(noSleep.enableCalls, 1);
  assert.equal(documentRef.count('click'), 0, 'activation listeners are removed after the first tap');
  assert.equal(documentRef.count('touchend'), 0);

  documentRef.dispatch('click');
  await settle();
  assert.equal(noSleep.enableCalls, 1, 'later taps do not re-request');

  cleanup();
  assert.equal(noSleep.disableCalls, 1);
  assert.equal(documentRef.count('visibilitychange'), 0);
});

test('a refused request re-arms for the next tap', async () => {
  const documentRef = createDocument();
  const noSleep = createNoSleepStub({ fail: 1 });
  const cleanup = initScreenWakeRuntime({
    windowRef: { location: { pathname: '/remote' } },
    documentRef,
    navigatorRef: {},
    createNoSleep: () => noSleep,
    log: silentLog,
  });

  documentRef.dispatch('click');
  await settle();
  assert.equal(noSleep.enableCalls, 1);
  assert.equal(documentRef.count('click'), 1, 'listening again after the refusal');

  documentRef.dispatch('click');
  await settle();
  assert.equal(noSleep.enableCalls, 2);
  assert.equal(documentRef.count('click'), 0);
  cleanup();
});

test('the video fallback is restarted when the page becomes visible again', async () => {
  const documentRef = createDocument();
  const noSleep = createNoSleepStub();
  const cleanup = initScreenWakeRuntime({
    windowRef: { location: { pathname: '/remote' } },
    documentRef,
    navigatorRef: {},
    createNoSleep: () => noSleep,
    log: silentLog,
  });

  documentRef.visibilityState = 'visible';
  documentRef.dispatch('visibilitychange');
  await settle();
  assert.equal(noSleep.enableCalls, 0, 'never before a gesture');

  documentRef.dispatch('click');
  await settle();
  assert.equal(noSleep.enableCalls, 1);

  documentRef.visibilityState = 'hidden';
  documentRef.dispatch('visibilitychange');
  documentRef.visibilityState = 'visible';
  documentRef.dispatch('visibilitychange');
  await settle();
  assert.equal(noSleep.enableCalls, 2);
  cleanup();
});

test('the native wake lock is left to NoSleep on visibility changes', async () => {
  const documentRef = createDocument();
  const noSleep = createNoSleepStub();
  const cleanup = initScreenWakeRuntime({
    windowRef: { location: { pathname: '/remote' } },
    documentRef,
    navigatorRef: { wakeLock: {} },
    createNoSleep: () => noSleep,
    log: silentLog,
  });

  documentRef.dispatch('click');
  await settle();
  documentRef.dispatch('visibilitychange');
  await settle();
  assert.equal(noSleep.enableCalls, 1, 'no second request from this runtime');
  cleanup();
});

test('a NoSleep constructor failure leaves the page untouched', () => {
  const documentRef = createDocument();
  const cleanup = initScreenWakeRuntime({
    windowRef: { location: { pathname: '/remote' } },
    documentRef,
    navigatorRef: {},
    createNoSleep: () => { throw new Error('no video element'); },
    log: silentLog,
  });
  assert.equal(documentRef.count('click'), 0);
  assert.equal(documentRef.count('visibilitychange'), 0);
  cleanup();
});

for (const outcome of ['granted', 'refused']) {
  test(`cleanup remains final when a pending wake-lock request is ${outcome}`, async () => {
    const documentRef = createDocument();
    let finish;
    let held = false;
    const noSleep = {
      enable: () => new Promise((resolve, reject) => {
        finish = () => {
          if (outcome === 'refused') reject(new Error('NotAllowedError'));
          else { held = true; resolve(); }
        };
      }),
      disable: () => { held = false; },
    };
    const cleanup = initScreenWakeRuntime({
      windowRef: { location: { pathname: '/remote' } }, documentRef,
      navigatorRef: { wakeLock: {} }, createNoSleep: () => noSleep, log: silentLog,
    });
    documentRef.dispatch('click');
    cleanup();
    finish(); await settle();
    assert.equal(held, false, 'a late grant must release the screen lock');
    for (const type of ['click', 'touchend', 'keydown', 'visibilitychange']) {
      assert.equal(documentRef.count(type), 0, 'a late refusal cannot revive activation listeners');
    }
  });
}
