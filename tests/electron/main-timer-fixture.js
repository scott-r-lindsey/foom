// Loaded only inside the fixture Electron main process. Capture timers from one
// synchronous production method while leaving every other main timer on real time.
function captureTimers(run, timers) {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    const handle = nativeSetTimeout(() => {}, delay);
    timers.set(handle, {
      delay,
      fire() {
        nativeClearTimeout(handle);
        timers.delete(handle);
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
