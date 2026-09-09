import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const pkg = require('../../scripts/lib/package');
const { buildEnv, releaseEnv, FIXTURE_CLIENT_ID } = require('../../scripts/lib/build-env');
const release = require('../../scripts/release');
const roots: string[] = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tidl-release-')); roots.push(dir); return dir; }
function git(cwd: string, ...args: string[]) { return pkg.run('git', args, cwd).trim(); }
function fixture() {
  const cwd = temp();
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'tidl', version: '0.1.2' }));
  fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({ version: '0.1.2', packages: { '': { version: '0.1.2' } } }));
  fs.writeFileSync(path.join(cwd, 'manifest.json'), JSON.stringify({ version: '0.1.2', manifest_version: 3 }));
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'dist/\nreleases/\n');
  fs.mkdirSync(path.join(cwd, 'scripts'));
  fs.copyFileSync('scripts/release-scan.js', path.join(cwd, 'scripts/release-scan.js'));
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Release Test');
  git(cwd, 'config', 'user.email', 'test@example.invalid');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'Initial');
  const remote = temp();
  git(remote, 'init', '--bare');
  git(cwd, 'remote', 'add', 'origin', remote);
  git(cwd, 'push', '-u', 'origin', 'main');
  return { cwd, remote };
}
function fakePackage({ cwd }: { cwd: string }) {
  const version = pkg.readVersion(cwd);
  const filename = `tidl-${version}.zip`;
  const dir = path.join(cwd, 'releases');
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, filename);
  pkg.run('zip', ['-q', zip, 'manifest.json'], cwd);
  const checksum = pkg.sha256(fs.readFileSync(zip));
  fs.writeFileSync(`${zip}.sha256`, `${checksum}  ${filename}\n`);
  return { version, filename, zip, checksum };
}
function liveEnv() {
  vi.stubEnv('GITHUB_ACTIONS', 'true'); vi.stubEnv('GITHUB_REF', 'refs/heads/main');
  vi.stubEnv('GITHUB_EVENT_NAME', 'workflow_dispatch'); vi.stubEnv('GITHUB_RUN_ID', '123');
  vi.stubEnv('GITHUB_REPOSITORY', 'Matcote/tidl'); vi.stubEnv('TIDAL_CLIENT_ID', 'test-public-client-id');
}
beforeEach(() => { vi.stubEnv('GITHUB_OUTPUT', ''); vi.stubEnv('GITHUB_STEP_SUMMARY', ''); });
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); });

describe('release configuration and versions', () => {
  it.each([['0.1.2', 'patch', '0.1.3'], ['0.1.2', 'minor', '0.2.0'], ['0.1.2', 'major', '1.0.0']])('bumps %s %s', (v, b, result) => expect(pkg.nextVersion(v, b)).toBe(result));
  it.each(['0.0.0', '01.2.3', '1.2.3-beta', '1.2', '65536.0.0', '../1.2.3'])('rejects %s', v => expect(() => pkg.versionParts(v)).toThrow());
  it('rejects overflow and unsupported bumps', () => {
    expect(() => pkg.nextVersion('1.2.65535', 'patch')).toThrow();
    expect(() => pkg.nextVersion('1.2.3', 'prerelease')).toThrow();
  });
  it('synchronizes all versions and rejects disagreement', () => {
    const { cwd } = fixture(); pkg.writeVersion('0.2.0', cwd);
    expect(pkg.readVersion(cwd)).toBe('0.2.0');
    const lock = JSON.parse(fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8'));
    lock.packages[''].version = '0.1.2';
    fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify(lock));
    expect(() => pkg.readVersion(cwd)).toThrow('must match');
  });
  it('gives process configuration precedence, including explicit blank values', () => {
    const cwd = temp(); fs.writeFileSync(path.join(cwd, '.env'), 'TIDAL_CLIENT_ID="from-file"\n');
    expect(buildEnv({}, cwd).clientId).toBe('from-file');
    expect(buildEnv({ TIDAL_CLIENT_ID: 'from-env' }, cwd).clientId).toBe('from-env');
    expect(() => releaseEnv({ TIDAL_CLIENT_ID: ' ' }, cwd)).toThrow('requires');
    expect(() => releaseEnv({ TIDL_DEV_SERVER_URL: 'http://localhost:8787' }, cwd)).toThrow('rejects');
    expect(() => releaseEnv({ TIDAL_CLIENT_ID: FIXTURE_CLIENT_ID }, cwd)).toThrow('cannot be published');
    expect(releaseEnv({ TIDAL_CLIENT_ID: FIXTURE_CLIENT_ID }, cwd, true).clientId).toBe(FIXTURE_CLIENT_ID);
  });
});

describe('prepare, finalize, and artifact recovery', () => {
  it('dry run changes no tracked files or git refs and never calls the store', async () => {
    const { cwd, remote } = fixture(); liveEnv();
    const before = git(cwd, 'rev-parse', 'HEAD');
    const original = pkg.VERSION_FILES.map((f: string) => fs.readFileSync(path.join(cwd, f), 'utf8'));
    const storeClient = { status: vi.fn() };
    const result = await release.prepare({ cwd, dryRun: true, storeClient, checkFn: vi.fn(), packageFn: fakePackage });
    expect(result.version).toBe('0.1.3'); expect(result.releaseCommit).toBeNull();
    expect(storeClient.status).not.toHaveBeenCalled();
    expect(git(cwd, 'status', '--porcelain')).toBe(''); expect(git(cwd, 'tag')).toBe('');
    expect(git(remote, 'rev-parse', 'main')).toBe(before);
    expect(pkg.VERSION_FILES.map((f: string) => fs.readFileSync(path.join(cwd, f), 'utf8'))).toEqual(original);
    expect(() => release.verifyArtifacts(cwd, 'v0.1.3')).toThrow('dry-run');
  });
  it('restores files after a failed dry-run check without packaging', async () => {
    const { cwd } = fixture(); liveEnv(); const packageFn = vi.fn();
    await expect(release.prepare({ cwd, dryRun: true, checkFn: () => { throw Error('test failed'); }, packageFn })).rejects.toThrow('test failed');
    expect(packageFn).not.toHaveBeenCalled(); expect(git(cwd, 'status', '--porcelain')).toBe('');
  });
  it('rejects duplicate tags and dirty trees before running checks', async () => {
    const { cwd } = fixture(); liveEnv(); git(cwd, 'tag', 'v0.1.3');
    await expect(release.prepare({ cwd, dryRun: true })).rejects.toThrow('already exists');
    fs.writeFileSync(path.join(cwd, 'new-file'), 'uncommitted');
    await expect(release.prepare({ cwd, dryRun: true })).rejects.toThrow('clean');
  });
  it('prepares locally, binds artifacts to the tag, and atomically pushes the tested commit', async () => {
    const { cwd, remote } = fixture(); liveEnv();
    const source = git(cwd, 'rev-parse', 'HEAD'); const checkFn = vi.fn();
    const meta = await release.prepare({ cwd, checkFn, packageFn: fakePackage, storeClient: { status: async () => ({}) } });
    expect(checkFn).toHaveBeenCalledOnce(); expect(git(remote, 'rev-parse', 'main')).toBe(source);
    expect(release.verifyArtifacts(cwd, meta.tag).checksum).toBe(meta.checksum);
    const createRelease = vi.fn(); release.finalize({ cwd, tag: meta.tag, githubReleaseFn: createRelease });
    expect(git(remote, 'rev-parse', 'main')).toBe(meta.releaseCommit);
    expect(git(remote, 'rev-parse', `${meta.tag}^{commit}`)).toBe(meta.releaseCommit);
    expect(createRelease).toHaveBeenCalledOnce();
    // Exact original artifacts remain verifiable after refs are pushed.
    expect(release.verifyArtifacts(cwd, meta.tag).sourceCommit).toBe(source);
  });
  it('does not push if main advanced after preparation', async () => {
    const { cwd, remote } = fixture(); liveEnv();
    const meta = await release.prepare({ cwd, checkFn: vi.fn(), packageFn: fakePackage, storeClient: { status: async () => ({}) } });
    const other = temp(); git(other, 'clone', '-b', 'main', remote, '.');
    git(other, 'config', 'user.name', 'Other'); git(other, 'config', 'user.email', 'other@example.invalid');
    git(other, 'commit', '--allow-empty', '-m', 'Concurrent'); git(other, 'push');
    expect(() => release.finalize({ cwd, tag: meta.tag, githubReleaseFn: vi.fn() })).toThrow('advanced');
    expect(git(remote, 'tag')).toBe('');
  });
  it('rejects tampered ZIP bytes and metadata', async () => {
    const { cwd } = fixture(); liveEnv();
    const meta = await release.prepare({ cwd, checkFn: vi.fn(), packageFn: fakePackage, storeClient: { status: async () => ({}) } });
    fs.appendFileSync(path.join(cwd, 'releases', meta.filename), 'tampered');
    expect(() => release.verifyArtifacts(cwd, meta.tag)).toThrow('checksum');
    const file = path.join(cwd, 'releases', `tidl-${meta.version}.json`);
    fs.appendFileSync(file, ' ');
    expect(() => release.verifyArtifacts(cwd, meta.tag)).toThrow('annotated tag');
  });
  it('resumes an existing tag with its original ZIP without building or changing refs', async () => {
    const { cwd, remote } = fixture(); liveEnv();
    const meta = await release.prepare({ cwd, checkFn: vi.fn(), packageFn: fakePackage, storeClient: { status: async () => ({}) } });
    release.finalize({ cwd, tag: meta.tag, githubReleaseFn: vi.fn() });
    const original = fs.readFileSync(path.join(cwd, 'releases', meta.filename));
    const storeClient = { status: vi.fn(async () => ({})), publish: vi.fn(async () => 'submitted for review') };
    const downloadFn = vi.fn(); const githubReleaseFn = vi.fn();
    expect(await release.resume({ cwd, tag: meta.tag, sourceRunId: '123', downloadFn, githubReleaseFn, storeClient })).toBe('submitted for review');
    expect(downloadFn).toHaveBeenCalledWith(cwd, meta.tag, '123');
    expect(storeClient.publish).toHaveBeenCalledWith(original, '0.1.3');
    expect(githubReleaseFn).toHaveBeenCalledOnce();
    expect(git(remote, 'rev-parse', 'main')).toBe(meta.releaseCommit);
    expect(git(cwd, 'status', '--porcelain')).toBe('');
  });
  it('dry-run resume verifies without creating a GitHub release or contacting the store', async () => {
    const { cwd } = fixture(); liveEnv();
    const meta = await release.prepare({ cwd, checkFn: vi.fn(), packageFn: fakePackage, storeClient: { status: async () => ({}) } });
    release.finalize({ cwd, tag: meta.tag, githubReleaseFn: vi.fn() });
    const storeClient = { status: vi.fn(), publish: vi.fn() }; const githubReleaseFn = vi.fn();
    await release.resume({ cwd, tag: meta.tag, dryRun: true, downloadFn: vi.fn(), githubReleaseFn, storeClient });
    expect(storeClient.status).not.toHaveBeenCalled(); expect(storeClient.publish).not.toHaveBeenCalled(); expect(githubReleaseFn).not.toHaveBeenCalled();
  });
  it('fails recovery for a missing artifact or mismatched originating run', async () => {
    const { cwd } = fixture(); liveEnv();
    const meta = await release.prepare({ cwd, checkFn: vi.fn(), packageFn: fakePackage, storeClient: { status: async () => ({}) } });
    release.finalize({ cwd, tag: meta.tag, githubReleaseFn: vi.fn() });
    const storeClient = { status: vi.fn(), publish: vi.fn() };
    await expect(release.resume({ cwd, tag: meta.tag, sourceRunId: '999', downloadFn: vi.fn(), storeClient })).rejects.toThrow('workflow run');
    fs.unlinkSync(path.join(cwd, 'releases', meta.filename));
    await expect(release.resume({ cwd, tag: meta.tag, downloadFn: vi.fn(), storeClient })).rejects.toThrow();
    expect(storeClient.status).not.toHaveBeenCalled(); expect(storeClient.publish).not.toHaveBeenCalled();
  });
  it('rejects a store destination change during recovery', async () => {
    const { cwd } = fixture(); liveEnv();
    const meta = await release.prepare({ cwd, checkFn: vi.fn(), packageFn: fakePackage, storeClient: { status: async () => ({}) } });
    vi.stubEnv('CWS_EXTENSION_ID', 'b'.repeat(32));
    const storeClient = { publish: vi.fn() };
    await expect(release.publish({ cwd, tag: meta.tag, storeClient })).rejects.toThrow('store target');
    expect(storeClient.publish).not.toHaveBeenCalled();
  });
  it('requires a deliberate main-branch live dispatch', () => {
    expect(() => release.requireMain({})).toThrow('workflow_dispatch');
    expect(() => release.requireMain({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/feature', GITHUB_EVENT_NAME: 'workflow_dispatch' })).toThrow();
  });
});

describe('production packaging', () => {
  it('builds a ZIP with manifest at root and a verifiable checksum', () => {
    const { cwd } = fixture();
    fs.writeFileSync(path.join(cwd, 'build.js'), `const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.copyFileSync('manifest.json','dist/manifest.json');fs.writeFileSync('dist/background.js','production code');`);
    const result = pkg.packageRelease({ cwd, env: { ...process.env, TIDAL_CLIENT_ID: 'test-id' } });
    expect(pkg.sha256(fs.readFileSync(result.zip))).toBe(result.checksum);
    expect(JSON.parse(pkg.run('unzip', ['-p', result.zip, 'manifest.json'], cwd)).version).toBe('0.1.2');
    expect(fs.readFileSync(`${result.zip}.sha256`, 'utf8')).toContain(result.checksum);
  });
  it.each(['sourceMappingURL', 'TIDL_DEV_SERVER_URL', 'TIDAL_CLIENT_SECRET', 'private-test-secret-123456'])('blocks forbidden artifact content: %s', content => {
    const { cwd } = fixture();
    fs.writeFileSync(path.join(cwd, 'build.js'), `const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.copyFileSync('manifest.json','dist/manifest.json');fs.writeFileSync('dist/background.js',${JSON.stringify(content)});`);
    expect(() => pkg.packageRelease({ cwd, env: { ...process.env, TIDAL_CLIENT_ID: 'test-id', TIDAL_CLIENT_SECRET: 'private-test-secret-123456' } })).toThrow();
  });
});
