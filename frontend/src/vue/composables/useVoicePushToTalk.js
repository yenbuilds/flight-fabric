import { onBeforeUnmount } from 'vue';

// Press/release bookkeeping for an on-screen hold-to-talk button. A press the
// runtime refuses clears itself so the next press is not swallowed, and
// unmounting mid-press cancels rather than sending half an utterance.
export function useVoicePushToTalk(voice) {
  let localPress = null;

  function beginLocalPress() {
    if (localPress || !voice.ready) return;
    const press = {};
    localPress = press;
    void Promise.resolve(voice.pressToTalk()).then((started) => {
      if (started === false && localPress === press) localPress = null;
    });
  }

  function press(event) {
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    beginLocalPress();
  }

  function pressWithKeyboard(event) {
    if (!event.repeat) beginLocalPress();
  }

  function release() {
    if (!localPress) return;
    localPress = null;
    void voice.releaseToTalk();
  }

  function cancelLocalPress() {
    if (!localPress) return;
    localPress = null;
    void voice.cancel();
  }

  onBeforeUnmount(cancelLocalPress);

  return { press, pressWithKeyboard, release, cancelLocalPress };
}
