// Capture timers from one synchronous Electron main method while leaving every
// other timer on real time.
function captureTimers(run, timers) {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    const parkedCallback = () => {};
    const handle = nativeSetTimeout(parkedCallback, delay);
    timers.set(handle, {
      delay,
      fire() {
        // Node clears _onTimeout on cancellation, including calls to native
        // clearTimeout after capture has restored the globals.
        if (!timers.delete(handle) || handle._onTimeout !== parkedCallback) {
          throw new Error("Cannot fire an inactive captured timer");
        }
        nativeClearTimeout(handle);
        callback(...args);
      },
    });
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    timers.delete(handle);
    nativeClearTimeout(handle);
  };
  try {
    return run();
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
  }
}

module.exports = { captureTimers };
