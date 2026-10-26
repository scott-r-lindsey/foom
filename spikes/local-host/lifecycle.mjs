// Throwaway Unix lifecycle probe. No PTYs, shells, product imports or network.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const self = fileURLToPath(import.meta.url);
const [mode, root] = process.argv.slice(2);
const controlledEnv = { PATH: '/usr/bin:/bin' };
if (mode === 'daemon') {
  process.umask(0o077);
  const socket = join(root, 'h.sock');
  const server = createServer(client => client.end(`fixture:${process.pid}\n`));
  server.listen(socket);
  await once(server, 'listening');
  await chmod(socket, 0o600);
  await writeFile(join(root, 'ready'), String(process.pid), { mode: 0o600 });
  process.on('SIGTERM', () => server.close());
  // Bound even an interrupted runner; no persistent service is installed.
  setTimeout(() => server.close(), 15000);
} else if (mode === 'parent') {
  const child = spawn(process.execPath, [self, 'daemon', root], {
    detached: true, stdio: 'ignore', env: controlledEnv,
  });
  child.on('error', () => process.exit(1));
  child.unref();
  process.send({ pid: child.pid });
  process.on('message', () => process.exit(0));
} else {
  assert.equal(process.platform === 'linux' || process.platform === 'darwin', true);
  async function probe(crash) {
    const dir = await mkdtemp(join(tmpdir(), 'foom846-'));
    let parent;
    let daemonPid;
    try {
      parent = spawn(process.execPath, [self, 'parent', dir], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: controlledEnv,
      });
      const [message] = await once(parent, 'message');
      daemonPid = message.pid;
      let ready = false;
      for (let n = 0; n < 100; n++) {
        try {
          assert.equal(Number(await readFile(join(dir, 'ready'), 'utf8')), daemonPid);
          ready = true;
          break;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await delay(25);
        }
      }
      assert.equal(ready, true, 'daemon ready');
      const exited = once(parent, 'exit');
      if (crash) parent.kill('SIGKILL');
      else parent.send('quit');
      await exited;
      const path = join(dir, 'h.sock');
      assert.equal((await lstat(dir)).mode & 0o777, 0o700);
      assert.equal((await lstat(path)).mode & 0o777, 0o600);
      // This independent same-UID client has no secret: permissions allow it.
      const client = createConnection(path);
      client.setEncoding('utf8');
      let response = '';
      client.on('data', chunk => { response += chunk; });
      await once(client, 'end');
      assert.equal(response, `fixture:${daemonPid}\n`);
      return { parent: crash ? 'SIGKILL' : 'normal exit', survived: true, sameUidConnected: true };
    } finally {
      if (parent?.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
      if (daemonPid) {
        try { process.kill(daemonPid, 'SIGTERM'); } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
        // The fixture has no children or native cleanup; force retirement before removal.
        await delay(50);
        try { process.kill(daemonPid, 'SIGKILL'); } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({ platform: process.platform, node: process.version,
    results: [await probe(false), await probe(true)] }, null, 2));
}
