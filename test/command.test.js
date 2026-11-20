const test = require('node:test');
const assert = require('node:assert');
const { hasCommand, commandLines, buildScript, scriptPath, launchArgs } = require('../src/command');

test('hasCommand only when there is real text', () => {
  assert.strictEqual(hasCommand('npm start'), true);
  for (const blank of ['', '   ', '\n\n', null, undefined, 42]) assert.strictEqual(hasCommand(blank), false);
});

test('commandLines drops blank lines and trailing spaces, keeps order', () => {
  const text = 'cd C:\\repo  \n\ngit switch feature/x\n   \nnpm start';
  assert.deepStrictEqual(commandLines(text), ['cd C:\\repo', 'git switch feature/x', 'npm start']);
});

test('buildScript wraps the lines in a try/catch and keeps them verbatim', () => {
  const script = buildScript('cd C:\\repo\nnpm start');
  assert.match(script, /\$ErrorActionPreference = "Stop"/);
  assert.match(script, /^ {2}cd C:\\repo$/m);
  assert.match(script, /^ {2}npm start$/m);
  assert.match(script, /catch \{/);
  assert.ok(script.endsWith('\r\n'));
});

test('buildScript uses CRLF so PowerShell reads each line right', () => {
  assert.ok(buildScript('a\nb').includes('\r\n'));
});

test('buildScript refuses an empty command', () => {
  assert.throws(() => buildScript('   \n  '), /no command/);
});

test('a command with special characters is not escaped or altered', () => {
  // These would be dangerous if we built a command-line string; in a .ps1 file
  // they are just text on their own lines.
  const nasty = 'echo "a; rm -rf /"\ngit commit -m "fix & ship"';
  const script = buildScript(nasty);
  assert.match(script, /echo "a; rm -rf \/"/);
  assert.match(script, /git commit -m "fix & ship"/);
});

test('scriptPath lands in the given dir with a .ps1 name, and is unique', () => {
  const a = scriptPath('C:\\tmp');
  const b = scriptPath('C:\\tmp');
  assert.match(a, /mochi-run-[0-9a-f]{12}\.ps1$/);
  assert.ok(a.startsWith('C:\\tmp'));
  assert.notStrictEqual(a, b);
});

test('launchArgs opens the file in a window that stays open', () => {
  assert.deepStrictEqual(launchArgs('C:\\tmp\\x.ps1'),
    ['-NoExit', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\tmp\\x.ps1']);
});
