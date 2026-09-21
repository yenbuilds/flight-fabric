#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const url = file => pathToFileURL(path.resolve(__dirname, '../../frontend', file)).href;
  const { createPinia, setActivePinia } = await import(url('node_modules/pinia/dist/pinia.mjs'));
  const { useTimelineStore } = await import(url('src/vue/stores/timeline.js'));
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
  let now = 0, sequence = 0;
  const timers = new Map();
  globalThis.setTimeout = (callback, delay) => { const id=++sequence; timers.set(id,{callback,at:now+delay}); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  function advance(ms) {
    now += ms;
    for (const [id,timer] of [...timers]) if(timer.at<=now) { timers.delete(id); timer.callback(); }
  }
  try {
    setActivePinia(createPinia());
    const store = useTimelineStore(), sent = [];
    store.bindRequestActions({onRequestTimeline: payload => { sent.push(payload); return true; }});
    store.ingestMessage({type:'timelineList', flights:[]});
    store.requestTimeline('first.csv', 'FIRST', {flightLabel:'YSSY-YMML'});
    const interruptedId = sent.at(-1).requestId;
    store.markListDisconnected();
    assert.equal(store.timelineLoading,false,'disconnect ends an accepted recording load');
    assert.match(store.timelineLoadError,/connection was interrupted/i);
    assert.equal(store.canRetryTimeline,false,'retry remains unavailable offline');
    assert.equal(store.isCurrentTimelineRequestMessage({requestId:interruptedId}),false,'late interrupted reply is ignored');
    store.ingestMessage({type:'timelineList',flights:[]});
    assert.equal(store.canRetryTimeline,true,'reconnect exposes explicit retry instead of leaving a spinner');
    assert.equal(store.retryTimeline(),true);
    assert.equal(sent.at(-1).filePath,'first.csv');
    assert.equal(store.timelineLoadingFlightLabel,'YSSY-YMML');
    const expiredId=sent.at(-1).requestId;
    advance(59_999);
    assert.equal(store.timelineLoading,true,'large recordings have a full response window');
    advance(1);
    assert.equal(store.timelineLoading,false,'missing replies have a bounded wait');
    assert.match(store.timelineLoadError,/too long to load/i);
    assert.equal(store.isCurrentTimelineRequestMessage({requestId:expiredId}),false,'expired replies cannot overwrite a retry');
    store.retryTimeline();
    store.setLoadedTimelineIdentity({filePath:'first.csv',flightId:'FIRST'});
    store.timelineLoadingStartedAtMs=-10_000;
    store.finishTimelineLoading();
    advance(60_000);
    assert.equal(store.timelineLoadError,'','successful replies cancel the timeout');
    assert.equal(store.loadedTimelineFlightId,'FIRST');
    store.requestTimeline('received.csv','RECEIVED');
    store.setLoadedTimelineIdentity({filePath:'received.csv',flightId:'RECEIVED'});
    store.finishTimelineLoading();
    store.markListDisconnected();
    assert.equal(store.timelineLoading,false,'disconnect clears a minimum-duration spinner after a successful reply');
    assert.equal(store.timelineLoadError,'','a completed response does not turn into a connection failure');
    assert.equal(store.loadedTimelineFlightId,'RECEIVED','successfully received flight stays available');
    store.ingestMessage({type:'timelineList',flights:[]});
    store.requestTimeline('older.csv','OLDER');
    advance(30_000);
    store.requestTimeline('newer.csv','NEWER');
    advance(30_000);
    assert.equal(store.timelineLoading,true,'the older request deadline cannot fail a newer request');
    assert.equal(store.timelineLoadingFlightKey,'newer.csv');
    store.markListRestricted();
    const sentBeforeRetry=sent.length;
    assert.equal(store.retryTimeline(),false,'revoked history scope cannot retry retained recording requests');
    assert.equal(sent.length,sentBeforeRetry);
    advance(60_000);
    assert.equal(store.timelineLoading,false,'revocation also cancels outstanding deadlines');
    store.clearTimelineLoading();
    assert.equal(timers.size,0,'recording request timers are cleaned up');
    console.log('Timeline recovery passed: disconnect, reconnect/retry, deadline, late replies, superseded requests, successful cleanup and restricted access.');
  } finally {
    globalThis.setTimeout=originalSetTimeout;
    globalThis.clearTimeout=originalClearTimeout;
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
