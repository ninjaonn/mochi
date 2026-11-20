// "Run command" support for a key: open a new PowerShell window and run the
// saved lines there. This is powerful, so it is gated behind an unlock and the
// command is stored encrypted in the vault, never in notes.md.
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// A key counts as a command when it has one. Blank/whitespace does not.
function hasCommand(text) {
  return typeof text === 'string' && text.trim().length > 0;
}

// Split into lines, dropping blank lines and trailing whitespace. We keep the
// user's lines verbatim otherwise — this runs their own shell commands.
function commandLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0);
}

// Write the lines to a one-shot .ps1 in a temp dir, so nothing is interpolated
// onto a command line (no quoting pitfalls, no injection through args). The
// window stays open after the script so a long-running `npm start` keeps going
// and errors stay visible.
function buildScript(text) {
  const lines = commandLines(text);
  if (!lines.length) throw new Error('This key has no command');
  const header = [
    '# Written by Mochi Vault. Safe to delete.',
    '$ErrorActionPreference = "Stop"',
    'try {',
  ];
  const body = lines.map((line) => '  ' + line);
  const footer = [
    '} catch {',
    '  Write-Host $_.Exception.Message -ForegroundColor Red',
    '}',
  ];
  return header.concat(body, footer).join('\r\n') + '\r\n';
}

function scriptPath(dir = os.tmpdir()) {
  return path.join(dir, `mochi-run-${crypto.randomBytes(6).toString('hex')}.ps1`);
}

// The arguments for launching Windows PowerShell on that script, in a new
// window. -NoExit keeps it open; -ExecutionPolicy Bypass runs our own file
// without changing the machine policy.
function launchArgs(file) {
  return ['-NoExit', '-ExecutionPolicy', 'Bypass', '-File', file];
}

module.exports = { hasCommand, commandLines, buildScript, scriptPath, launchArgs };
