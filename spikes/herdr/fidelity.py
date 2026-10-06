"""Bounded synthetic terminal fixture; no user files, agents, or credentials."""
import os
import select
import sys
import termios
import tty

old = termios.tcgetattr(sys.stdin)
try:
    tty.setraw(sys.stdin)
    sys.stdout.write('\x1b[?1049h\x1b[2J\x1b[H')
    sys.stdout.write('\x1b]2;FOOM_SPIKE_TITLE\x07\x1b]9;4;1;42\x07')
    sys.stdout.write('FIDELITY \x1b[38;2;18;52;86mTRUECOLOR\x1b[0m 界 e\u0301\r\n')
    sys.stdout.write('\x1b]8;;https://example.invalid/foom\x1b\\LINK\x1b]8;;\x1b\\\r\n')
    sys.stdout.write('\x1b[5 q\x1b[?25h\x1b[?2004h\x1b[?1000h\x1b[?1006h')
    sys.stdout.flush()
    received = b''
    for _ in range(100):
        if select.select([sys.stdin], [], [], 0.1)[0]:
            chunk = os.read(sys.stdin.fileno(), 4096)
            received += chunk
            if b'h' in chunk:
                sys.stdout.write('\x1b[?25l')
                sys.stdout.flush()
            if b'q' in chunk:
                break
finally:
    sys.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?1049l')
    sys.stdout.flush()
    termios.tcsetattr(sys.stdin, termios.TCSANOW, old)
print('INPUT_HEX', received.hex(), flush=True)
