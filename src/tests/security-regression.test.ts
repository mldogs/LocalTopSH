import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeWrite,
  executeEdit,
  executeSearchText,
  executeListDirectory,
} from '../tools/files.js';
import { execute as executeRunCommand } from '../tools/bash.js';
import { execute as executeSendFile } from '../tools/sendFile.js';
import { setSendFileCallback } from '../tools/sendFile.js';
import { executeFetchPage } from '../tools/web.js';

const TEST_WS = '/tmp/localtopsh_test_ws/123';

test('TC-WRITE-HTTP-EXFIL: write_file blocks training HTTP exfil server pattern', async () => {
  const code = `
import http from 'http';
import fs from 'fs';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/ls') {
    const d = url.searchParams.get('d');
    res.end(JSON.stringify(fs.readdirSync(d)));
    return;
  }
  if (url.pathname === '/cat') {
    const f = url.searchParams.get('f');
    res.end(fs.readFileSync(f, 'utf-8'));
    return;
  }
});
server.listen(4011);
`;

  const result = await executeWrite({ path: 'server4011.js', content: code }, TEST_WS);
  assert.equal(result.success, false);
  assert.match(result.error || '', /BLOCKED/i);
});

test('TC-EDIT-HTTP-EXFIL: edit_file blocks training HTTP exfil server pattern', async () => {
  const initial = 'console.log("ok");\n';
  const writeResult = await executeWrite({ path: 'safe.js', content: initial }, TEST_WS);
  assert.equal(writeResult.success, true);

  const payload = `${initial}\n// add server\nimport http from 'http';\nimport fs from 'fs';\nhttp.createServer((req,res)=>res.end(fs.readFileSync(req.url))).listen(4011);\n`;
  const result = await executeEdit({ path: 'safe.js', old_text: initial, new_text: payload }, TEST_WS);
  assert.equal(result.success, false);
  assert.match(result.error || '', /BLOCKED/i);
});

test('TC-PATH-WORKSPACE-BOUNDARY: read/search/list cannot access /workspace root', async () => {
  const list = await executeListDirectory({ path: '/workspace' }, '/workspace/123');
  assert.equal(list.success, false);
  assert.match(list.error || '', /BLOCKED/i);

  const search = await executeSearchText({ pattern: 'hello', path: '/workspace' }, '/workspace/123');
  assert.equal(search.success, false);
  assert.match(search.error || '', /BLOCKED/i);
});

test('TC-PATH-PREFIX-BYPASS: /workspace/123 must not allow /workspace/1234 access', async () => {
  const list = await executeListDirectory({ path: '/workspace/1234' }, '/workspace/123');
  assert.equal(list.success, false);
  assert.match(list.error || '', /BLOCKED/i);

  const search = await executeSearchText({ pattern: 'x', path: '/workspace/1234' }, '/workspace/123');
  assert.equal(search.success, false);
  assert.match(search.error || '', /BLOCKED/i);
});

test('TC-SENDFILE-OTHER-USER: send_file cannot send /workspace/other-user file', async () => {
  setSendFileCallback(async () => {});
  const result = await executeSendFile({ path: '/workspace/999/any.txt' }, '/workspace/123', 1);
  assert.equal(result.success, false);
  assert.match(result.error || '', /BLOCKED/i);
});

test('TC-CMD-SERVER-SPAWN: run_command blocks server start commands', async () => {
  const pythonHttp = await executeRunCommand({ command: 'python3 -m http.server 4011' }, { cwd: TEST_WS });
  assert.equal(pythonHttp.success, false);
  assert.match(pythonHttp.error || '', /BLOCKED/i);

  const nodeInline = await executeRunCommand({ command: "node -e \"require('http').createServer(()=>{}).listen(4011)\"" }, { cwd: TEST_WS });
  assert.equal(nodeInline.success, false);
  assert.match(nodeInline.error || '', /BLOCKED/i);
});

test('TC-CMD-SCRIPT-SECRETS: run_command blocks scripts referencing /run/secrets', async () => {
  const script = `import fs from 'fs';\nconsole.log(fs.readFileSync('/run/secrets/telegram_token', 'utf-8'));\n`;
  const writeResult = await executeWrite({ path: 'readsecret.js', content: script }, TEST_WS);
  assert.equal(writeResult.success, true);

  const scriptPath = `${TEST_WS}/readsecret.js`;
  const result = await executeRunCommand({ command: `node ${scriptPath}` }, { cwd: TEST_WS });
  assert.equal(result.success, false);
  assert.match(result.error || '', /BLOCKED/i);
});

test('TC-CMD-SCRIPT-OTHER-WS: run_command blocks scripts referencing other workspaces', async () => {
  const script = `import fs from 'fs';\nconsole.log(fs.readdirSync('/workspace/999'));\n`;
  const writeResult = await executeWrite({ path: 'read_other.js', content: script }, TEST_WS);
  assert.equal(writeResult.success, true);

  const scriptPath = `${TEST_WS}/read_other.js`;
  const result = await executeRunCommand({ command: `node ${scriptPath}` }, { cwd: '/workspace/123' });
  assert.equal(result.success, false);
  assert.match(result.error || '', /BLOCKED/i);
});

test('TC-CMD-SCRIPT-WS-ROOT: run_command blocks scripts referencing /workspace root', async () => {
  const script = `import fs from 'fs';\nconsole.log(fs.readdirSync('/workspace'));\n`;
  const writeResult = await executeWrite({ path: 'read_ws_root.js', content: script }, TEST_WS);
  assert.equal(writeResult.success, true);

  const scriptPath = `${TEST_WS}/read_ws_root.js`;
  const result = await executeRunCommand({ command: `node ${scriptPath}` }, { cwd: '/workspace/123' });
  assert.equal(result.success, false);
  assert.match(result.error || '', /BLOCKED/i);
});

test('TC-CMD-SCRIPT-PARENT-TRAVERSAL: run_command blocks scripts with ../ traversal', async () => {
  const script = `import fs from 'fs';\nconsole.log(fs.readdirSync('../'));\n`;
  const writeResult = await executeWrite({ path: 'read_parent.js', content: script }, TEST_WS);
  assert.equal(writeResult.success, true);

  const scriptPath = `${TEST_WS}/read_parent.js`;
  const result = await executeRunCommand({ command: `node ${scriptPath}` }, { cwd: '/workspace/123' });
  assert.equal(result.success, false);
  assert.match(result.error || '', /BLOCKED/i);
});

test('TC-CMD-PARENT-TRAVERSAL-CMD: run_command blocks `cd ..` and `../` in command strings', async () => {
  const cdUp = await executeRunCommand({ command: 'cd .. && ls' }, { cwd: '/workspace/123' });
  assert.equal(cdUp.success, false);
  assert.match(cdUp.error || '', /BLOCKED/i);

  const relRead = await executeRunCommand({ command: 'cat ../999/SESSION.json' }, { cwd: '/workspace/123' });
  assert.equal(relRead.success, false);
  assert.match(relRead.error || '', /BLOCKED/i);
});

test('TC-CMD-CD-ABS-ESCAPE: run_command blocks `cd /` / `cd /workspace` escapes', async () => {
  const cdRoot = await executeRunCommand({ command: 'cd / && ls workspace' }, { cwd: '/workspace/123' });
  assert.equal(cdRoot.success, false);
  assert.match(cdRoot.error || '', /BLOCKED/i);

  const cdWorkspaceRoot = await executeRunCommand({ command: 'cd /workspace && ls' }, { cwd: '/workspace/123' });
  assert.equal(cdWorkspaceRoot.success, false);
  assert.match(cdWorkspaceRoot.error || '', /BLOCKED/i);
});

test('TC-CMD-SECRETS-PATH: run_command blocks /run/secrets access', async () => {
  const readSecret = await executeRunCommand({ command: 'cat /run/secrets/telegram_token' }, { cwd: '/workspace/123' });
  assert.equal(readSecret.success, false);
  assert.match(readSecret.error || '', /BLOCKED/i);
});

test('TC-WEB-REDIRECT-SSRF: fetch_page blocks redirect to internal URL', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  (globalThis as any).fetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      return new Response('', {
        status: 302,
        headers: { location: 'http://127.0.0.1/' },
      });
    }
    return new Response('ok', { status: 200 });
  };

  try {
    const result = await executeFetchPage({ url: 'http://example.com' });
    assert.equal(result.success, false);
    assert.match(result.error || '', /BLOCKED/i);
  } finally {
    (globalThis as any).fetch = originalFetch;
  }
});
