const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { releaseEnv } = require('./build-env');
const VERSION_FILES = ['package.json', 'package-lock.json', 'manifest.json'];
function run(command, args, cwd = process.cwd(), options = {}) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}
function versionParts(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error(`Invalid release version: ${version}`);
  const parts = version.split('.').map(Number);
  if (parts.some(n => n > 65535) || parts.every(n => n === 0)) throw new Error(`Invalid Chrome version: ${version}`);
  return parts;
}
function nextVersion(version, bump) {
  const parts = versionParts(version);
  const index = ['major', 'minor', 'patch'].indexOf(bump);
  if (index < 0) throw new Error('Bump must be patch, minor, or major.');
  parts[index]++;
  parts.fill(0, index + 1);
  const next = parts.join('.');
  versionParts(next);
  return next;
}
function readVersion(cwd = process.cwd()) {
  const docs = VERSION_FILES.map(file => JSON.parse(fs.readFileSync(path.join(cwd, file), 'utf8')));
  const versions = [...docs.map(doc => doc.version), docs[1].packages?.['']?.version];
  versionParts(versions[0]);
  if (!versions.every(v => v === versions[0])) throw new Error('Package, lockfile, and manifest versions must match.');
  return versions[0];
}
function writeVersion(version, cwd) {
  versionParts(version);
  for (const file of VERSION_FILES) {
    const target = path.join(cwd, file);
    const doc = JSON.parse(fs.readFileSync(target, 'utf8'));
    doc.version = version;
    if (file === 'package-lock.json') doc.packages[''].version = version;
    fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`);
  }
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function packageRelease({ cwd = process.cwd(), allowFixture = false, env = process.env } = {}) {
  releaseEnv(env, cwd, allowFixture);
  const version = readVersion(cwd);
  run(process.execPath, ['build.js'], cwd, { env, stdio: 'inherit' });
  run(process.execPath, ['scripts/release-scan.js', 'dist'], cwd, { env, stdio: 'inherit' });
  const dir = path.join(cwd, 'releases');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `tidl-${version}.zip`;
  const zip = path.join(dir, filename);
  fs.rmSync(zip, { force: true });
  run('zip', ['-q', '-r', zip, '.'], path.join(cwd, 'dist'));
  run(process.execPath, ['scripts/release-scan.js', zip], cwd, { env, stdio: 'inherit' });
  const checksum = sha256(fs.readFileSync(zip));
  fs.writeFileSync(`${zip}.sha256`, `${checksum}  ${filename}\n`);
  return { version, filename, checksum, zip };
}
module.exports = { run, VERSION_FILES, versionParts, nextVersion, readVersion, writeVersion, sha256, packageRelease };
