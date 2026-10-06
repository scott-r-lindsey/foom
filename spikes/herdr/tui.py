"""Attach only to the harness's private session on a synthetic PTY."""
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

assert os.environ['XDG_CONFIG_HOME'].startswith('/tmp/foom-herdr-')
assert os.environ['HERDR_CONFIG_PATH'].startswith(os.environ['XDG_CONFIG_HOME'] + '/')
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
child = subprocess.Popen([sys.argv[1], '--session', 'foom-spike'], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
def stop(*_):
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
try:
    duration = float(sys.argv[2]) if len(sys.argv) > 2 else 3
    end = time.monotonic() + duration
    print('TUI_STARTED', flush=True)
    size_changed = False
    total = 0
    while time.monotonic() < end:
        if not size_changed and time.monotonic() > end - duration / 2:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 20, 60, 0, 0))
            child.send_signal(signal.SIGWINCH)
            size_changed = True
            print('TUI_RESIZED 60x20', flush=True)
        if select.select([master], [], [], 0.05)[0]:
            try:
                total += len(os.read(master, 65536))
            except OSError:
                break
    print('TUI_BYTES', total, 'RESIZED', size_changed, 'EXIT_BEFORE_STOP', child.poll())
finally:
    child.terminate()
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
    os.close(master)
