#!/usr/bin/env node

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const targets = process.argv.slice(2);
if (!targets.length) targets.push('dist');

const forbiddenStrings = [
  { label: 'source map reference', value: 'sourceMappingURL' },
  { label: 'inline source map sources', value: 'sourcesContent' },
  { label: 'dev server env marker', value: 'TIDL_DEV_SERVER_URL' },
  { label: 'client secret env marker', value: 'TIDAL_CLIENT_SECRET' },
];

for (const secret of loadSecretCandidates()) {
  forbiddenStrings.push({ label: 'configured TIDAL client secret', value: secret });
}

const findings = [];

for (const target of targets) {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    findings.push(`${target}: target does not exist`);
    continue;
  }

  if (resolved.endsWith('.zip')) {
    scanZip(resolved);
  } else {
    scanPath(resolved);
  }
}

if (findings.length) {
  console.error('[release-scan] Refusing to package unsafe release artifacts:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`[release-scan] OK: ${targets.join(', ')}`);

function loadSecretCandidates() {
  const values = new Set();
  addSecret(process.env.TIDAL_CLIENT_SECRET);

  const envFile = path.resolve('.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const eqIdx = line.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = line.slice(0, eqIdx).trim();
      if (key !== 'TIDAL_CLIENT_SECRET') continue;
      addSecret(line.slice(eqIdx + 1).trim());
    }
  }

  return [...values];

  function addSecret(value) {
    if (!value) return;
    const trimmed = String(value).trim();
    if (!trimmed || trimmed.includes('your_client_secret_here')) return;
    if (trimmed.length < 12) return;
    values.add(trimmed);
  }
}

function scanPath(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(filePath)) {
      scanPath(path.join(filePath, entry));
    }
    return;
  }

  if (filePath.endsWith('.map')) {
    findings.push(`${relative(filePath)}: source map file must not be shipped`);
    return;
  }

  scanBuffer(relative(filePath), fs.readFileSync(filePath));
}

function scanZip(zipPath) {
  const entries = childProcess.execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);

  for (const entry of entries) {
    if (entry.endsWith('/')) continue;
    if (entry.endsWith('.map')) {
      findings.push(`${relative(zipPath)}:${entry}: source map file must not be shipped`);
      continue;
    }

    const contents = childProcess.execFileSync('unzip', ['-p', zipPath, entry], {
      encoding: 'buffer',
      maxBuffer: 100 * 1024 * 1024,
    });
    scanBuffer(`${relative(zipPath)}:${entry}`, contents);
  }
}

function scanBuffer(label, buffer) {
  const text = buffer.toString('utf8');
  for (const forbidden of forbiddenStrings) {
    if (text.includes(forbidden.value)) {
      findings.push(`${label}: contains ${forbidden.label}`);
    }
  }
}

function relative(filePath) {
  return path.relative(process.cwd(), filePath) || filePath;
}
