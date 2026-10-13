"""Opt-in real-provider probe; uses existing agy login, never installs config/plugins."""
import argparse
import json
import os
import queue
import signal
import subprocess
import tempfile
import threading

parser = argparse.ArgumentParser()
parser.add_argument('--live', action='store_true', help='Allow three synthetic prompts using existing login')
args = parser.parse_args()
print(subprocess.check_output(['agy', '--version'], text=True).strip())
if not args.live:
    parser.exit(message='Pass --live to test two turns and post-exit resume (provider usage).\n')
if os.name != 'posix':
    parser.error('Process-group cleanup requires POSIX')

with tempfile.TemporaryDirectory(prefix='foom-followup-agy-') as cwd:
    processes = []

    def launch(extra=()):
        # Keep HOME/XDG unchanged: use the existing login without copying secrets.
        env = {key: value for key, value in os.environ.items() if not key.startswith('FOOM_')}
        proc = subprocess.Popen(
            ['agy', '--input-format', 'stream-json', '--output-format', 'stream-json',
             '--disable-slash-commands', '--mode', 'plan', '--sandbox', *extra],
            cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, start_new_session=True,
        )
        processes.append(proc)
        events = queue.Queue()

        def read():
            for line in proc.stdout:
                try:
                    events.put(json.loads(line))
                except json.JSONDecodeError:
                    pass
            events.put(None)

        threading.Thread(target=read, daemon=True).start()
        return proc, events

    def ask(proc, events, text):
        proc.stdin.write(json.dumps({'event': 'user', 'message': {'content': text}}) + '\n')
        proc.stdin.flush()
        while True:
            event = events.get(timeout=60)
            if event is None:
                raise RuntimeError('agy exited before result')
            if event.get('event') == 'result':
                result = event['result']
                assert result['status'] != 'ERROR', 'agy reported ERROR'
                assert result['response'].strip().lower().rstrip('.') == 'kumquat', 'Recall mismatch'
                return result['conversation_id']

    def finish(proc):
        proc.stdin.close()
        assert proc.wait(timeout=15) == 0

    try:
        proc, events = launch()
        first = ask(proc, events, 'Remember kumquat. Reply with only kumquat. Do not use tools.')
        followup = 'What word did I ask you to remember? Reply with only that word. Do not use tools.'
        assert ask(proc, events, followup) == first
        print('PASS: sequential stream turns preserve conversation ID and recall in same cwd')
        finish(proc)
        proc, events = launch(('--conversation', first))
        assert ask(proc, events, followup) == first
        finish(proc)
        print('PASS: post-exit conversation resume preserves ID and recall')
    finally:
        for proc in processes:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
            proc.stdout.close()
            if not proc.stdin.closed:
                proc.stdin.close()
