"""Record real PTY size and redraw on SIGWINCH; no model/agent invocation."""
import json
import os
import select
import signal
import subprocess
import sys


def record(event):
    rows, cols = map(int, subprocess.check_output(['stty', 'size']).split())
    with open(sys.argv[1], 'a') as log:
        log.write(json.dumps({'event': event, 'rows': rows, 'cols': cols}) + '\n')
    sys.stdout.write('\x1b[2J\x1b[HREFLOW %s %sx%s\r\n' % (event, cols, rows))
    sys.stdout.write(('0123456789' * 30) + '\r\n')
    sys.stdout.flush()


signal.signal(signal.SIGWINCH, lambda *_: record('SIGWINCH'))
record('start')
while True:
    if select.select([sys.stdin], [], [], 30)[0]:
        if not os.read(sys.stdin.fileno(), 4096):
            break
