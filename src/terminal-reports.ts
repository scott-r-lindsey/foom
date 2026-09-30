/* eslint-disable no-control-regex -- this module exists to match terminal control sequences */
// xterm answers terminal queries and reports focus and mouse motion through the same
// data channel as typing. Those bytes still go to the PTY, but they are not a reply.
const REPORTS = [
  /\x1b\[[IO]/y, // Focus in/out (DECSET 1004)
  // Cursor position report. Ctrl/Alt+F3 can look the same; that is not a reply either.
  /\x1b\[\??\d+;\d+R/y,
  /\x1b\[[?>=][\d;]*c/y, // Device attributes
  /\x1b\[\??[\d;]*\$y/y, // Mode report (DECRPM)
  /\x1b\[\d*n/y, // Device status
  /\x1b\[\d+(?:;\d+)*t/y, // Window reports
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/y, // OSC replies, e.g. colors
  /\x1bP[^\x1b]*\x1b\\/y, // DCS replies, e.g. DECRQSS
];
// A button press is deliberate; releases, motion and the wheel are not.
const SGR_MOUSE = /\x1b\[<(\d+);\d+;\d+([Mm])/y;
const X10_MOUSE = /\x1b\[M([\s\S])[\s\S]{2}/y;
const MOTION = 32;
const WHEEL = 64;

function passive(button: number, release: boolean): boolean {
  return release || (button & (MOTION | WHEEL)) !== 0;
}

/** True when the data contains anything the user typed, pasted or clicked. */
export function isReply(data: string): boolean {
  let index = 0;
  next: while (index < data.length) {
    for (const pattern of REPORTS) {
      pattern.lastIndex = index;
      if (pattern.test(data)) {
        index = pattern.lastIndex;
        continue next;
      }
    }
    SGR_MOUSE.lastIndex = index;
    const sgr = SGR_MOUSE.exec(data);
    if (sgr && passive(Number(sgr[1]), sgr[2] === "m")) {
      index = SGR_MOUSE.lastIndex;
      continue;
    }
    X10_MOUSE.lastIndex = index;
    const x10 = X10_MOUSE.exec(data);
    // X10 encodes the button as a byte offset by 32; 3 means release.
    const button = (x10?.[1]?.charCodeAt(0) ?? 0) - 32;
    if (x10 && passive(button, (button & 3) === 3)) {
      index = X10_MOUSE.lastIndex;
      continue;
    }
    return true;
  }
  return false;
}
