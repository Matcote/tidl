#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {
  run, VERSION_FILES, nextVersion, versionParts, readVersion, writeVersion, sha256, packageRelease,
} = require('./lib/package');
const { releaseEnv } = require('./lib/build-env');
const { createWebStore, assessStatus } = require('./lib/webstore');

function git(args, cwd) { return run('git', args, cwd).trim(); }
function output(values) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
    Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}
function summary(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
}
function store(env = process.env) {
  return createWebStore({ publisherId: env.CWS_PUBLISHER_ID, extensionId: env.CWS_EXTENSION_ID, token: env.CWS_ACCESS_TOKEN });
}
function validateTag(tag) {
  if (!tag?.startsWith('v')) throw new Error('release_tag must be v<major>.<minor>.<patch>.');
  versionParts(tag.slice(1));
  return tag;
}
function requireMain(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
    throw new Error('Live release operations require workflow_dispatch from main. Use --dry-run locally.');
  }
}
function assertRemoteUnchanged(cwd, expected) {
  const remote = git(['ls-remote', 'origin', 'refs/heads/main'], cwd).split(/\s/)[0];
  if (remote !== expected) throw new Error('main advanced while this release was being tested. Start a new prepare run; no refs were pushed.');
}
function assertTagAbsent(cwd, tag) {
  if (git(['tag', '--list', tag], cwd) || git(['ls-remote', 'origin', `refs/tags/${tag}`], cwd)) {
    throw new Error(`${tag} already exists. Use resume for the original artifact.`);
  }
}
function metadataPath(cwd, version) { return path.join(cwd, 'releases', `tidl-${version}.json`); }
async function prepare({ cwd = process.cwd(), bump = 'patch', dryRun = false,
  storeClient, packageFn = packageRelease, checkFn = checks } = {}) {
  if (!dryRun) requireMain();
  releaseEnv(process.env, cwd, dryRun);
  if (git(['status', '--porcelain'], cwd)) throw new Error('Release preparation requires a clean working tree.');
  const sourceCommit = git(['rev-parse', 'HEAD'], cwd);
  const version = nextVersion(readVersion(cwd), bump);
  const tag = `v${version}`;
  assertTagAbsent(cwd, tag);
  if (!dryRun) {
    assertRemoteUnchanged(cwd, sourceCommit);
    const state = assessStatus(await (storeClient ?? store()).status(), version);
    if (state !== 'ready') throw new Error(`Version ${version} is already ${state}. Use resume.`);
  }
  const originals = VERSION_FILES.map(file => fs.readFileSync(path.join(cwd, file)));
  try {
    writeVersion(version, cwd);
    checkFn(cwd);
    const packaged = packageFn({ cwd, allowFixture: dryRun });
    let releaseCommit = null;
    if (!dryRun) {
      git(['add', ...VERSION_FILES], cwd);
      // Checks already ran explicitly; avoid duplicate local hook execution.
      run('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', `Release ${version}`], cwd);
      releaseCommit = git(['rev-parse', 'HEAD'], cwd);
    }
    const metadata = {
      schemaVersion: 1, version, tag, filename: packaged.filename, checksum: packaged.checksum,
      sourceCommit, releaseCommit, workflowRunId: process.env.GITHUB_RUN_ID ?? null,
      repository: process.env.GITHUB_REPOSITORY ?? null, dryRun,
      store: dryRun ? null : { publisherId: process.env.CWS_PUBLISHER_ID, extensionId: process.env.CWS_EXTENSION_ID },
    };
    fs.writeFileSync(metadataPath(cwd, version), `${JSON.stringify(metadata, null, 2)}\n`);
    // Bind the metadata and ZIP to the immutable-by-policy annotated tag.
    if (!dryRun) git(['tag', '-a', tag, '-m', `tIDl release ${version}\nmetadata-sha256: ${sha256(fs.readFileSync(metadataPath(cwd, version)))}`], cwd);
    output({ tag, version, artifact: `release-${tag}`, directory: 'releases' });
    summary(`${dryRun ? 'Dry run' : 'Prepared'} ${tag}\n\nSource: ${sourceCommit}\n\nRelease commit: ${releaseCommit ?? 'none (dry run)'}\n\nZIP SHA-256: ${packaged.checksum}`);
    return metadata;
  } finally {
    if (dryRun) VERSION_FILES.forEach((file, i) => fs.writeFileSync(path.join(cwd, file), originals[i]));
  }
}
function checks(cwd) {
  const env = { ...process.env };
  // Tests must not inherit publishing credentials or write workflow outputs.
  for (const key of ['CWS_ACCESS_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_OUTPUT',
    'GITHUB_STEP_SUMMARY', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_RUNTIME_TOKEN']) delete env[key];
  for (const command of ['test', 'typecheck']) run('npm', ['run', command], cwd, { env, stdio: 'inherit' });
}
function verifyArtifacts(cwd, tag) {
  validateTag(tag);
  const version = tag.slice(1);
  const raw = fs.readFileSync(metadataPath(cwd, version));
  const meta = JSON.parse(raw);
  if (meta.schemaVersion !== 1 || meta.dryRun !== false || meta.tag !== tag || meta.version !== version ||
      meta.filename !== `tidl-${version}.zip` || !/^[0-9a-f]{40}$/.test(meta.releaseCommit) ||
      !/^[0-9a-f]{40}$/.test(meta.sourceCommit) || !/^\d+$/.test(meta.workflowRunId ?? '')) {
    throw new Error('Invalid release metadata or non-publishable dry-run artifact.');
  }
  if (process.env.GITHUB_REPOSITORY && meta.repository !== process.env.GITHUB_REPOSITORY) throw new Error('Artifact repository mismatch.');
  if (git(['rev-parse', `${tag}^{commit}`], cwd) !== meta.releaseCommit ||
      git(['rev-parse', `${tag}^`], cwd) !== meta.sourceCommit) throw new Error('Artifact commits do not match release tag.');
  const annotation = git(['for-each-ref', '--format=%(contents)', `refs/tags/${tag}`], cwd);
  if (!annotation.split('\n').includes(`metadata-sha256: ${sha256(raw)}`)) throw new Error('Release metadata does not match the annotated tag.');
  for (const file of VERSION_FILES) {
    const doc = JSON.parse(git(['show', `${tag}:${file}`], cwd));
    if (doc.version !== version || (file === 'package-lock.json' && doc.packages?.['']?.version !== version)) throw new Error('Tagged versions do not match.');
  }
  const zip = path.join(cwd, 'releases', meta.filename);
  const checksum = sha256(fs.readFileSync(zip));
  if (checksum !== meta.checksum || fs.readFileSync(`${zip}.sha256`, 'utf8') !== `${checksum}  ${meta.filename}\n`) throw new Error('ZIP checksum mismatch.');
  const entries = run('unzip', ['-Z1', zip], cwd).trim().split('\n');
  if (entries.filter(e => e === 'manifest.json').length !== 1 || new Set(entries).size !== entries.length ||
      entries.some(e => e.startsWith('/') || e.includes('\\') || e.split('/').includes('..'))) throw new Error('Invalid ZIP paths.');
  if (JSON.parse(run('unzip', ['-p', zip, 'manifest.json'], cwd)).version !== version) throw new Error('ZIP manifest version mismatch.');
  run(process.execPath, ['scripts/release-scan.js', zip], cwd, { stdio: 'inherit' });
  return { ...meta, zip };
}
function githubRelease(cwd, tag, meta) {
  let existing;
  try { existing = JSON.parse(run('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/releases/tags/${tag}`], cwd)); }
  catch (error) {
    if (!String(error.stderr).includes('404')) throw error;
  }
  if (!existing) {
    run('gh', ['release', 'create', tag, '--verify-tag', '--title', `tIDl ${meta.version}`,
      '--generate-notes', meta.zip, `${meta.zip}.sha256`, metadataPath(cwd, meta.version)], cwd);
  } else {
    // Reconcile partially-created GitHub releases without replacing assets.
    for (const file of [meta.zip, `${meta.zip}.sha256`, metadataPath(cwd, meta.version)]) {
      const asset = existing.assets.find(a => a.name === path.basename(file));
      if (!asset) run('gh', ['release', 'upload', tag, file], cwd);
      else {
        const bytes = run('gh', ['api', '-H', 'Accept: application/octet-stream',
          `repos/${process.env.GITHUB_REPOSITORY}/releases/assets/${asset.id}`], cwd, { encoding: 'buffer' });
        if (sha256(bytes) !== sha256(fs.readFileSync(file))) throw new Error('Existing GitHub release asset differs. Refusing overwrite.');
      }
    }
  }
  summary(`GitHub release: https://github.com/${process.env.GITHUB_REPOSITORY}/releases/tag/${tag}`);
}
function finalize({ cwd = process.cwd(), tag, githubReleaseFn = githubRelease }) {
  requireMain();
  const meta = verifyArtifacts(cwd, tag);
  if (git(['status', '--porcelain'], cwd)) throw new Error('Unexpected working-tree changes after preparation.');
  assertRemoteUnchanged(cwd, meta.sourceCommit);
  if (git(['ls-remote', 'origin', `refs/tags/${tag}`], cwd)) throw new Error('Release tag already exists remotely. Use resume.');
  git(['push', '--atomic', 'origin', `${meta.releaseCommit}:refs/heads/main`, `refs/tags/${tag}`], cwd);
  githubReleaseFn(cwd, tag, meta);
}
async function publish({ cwd = process.cwd(), tag, storeClient }) {
  requireMain();
  const meta = verifyArtifacts(cwd, tag);
  if (meta.store?.publisherId !== process.env.CWS_PUBLISHER_ID || meta.store?.extensionId !== process.env.CWS_EXTENSION_ID) {
    throw new Error('Configured store target differs from the original release.');
  }
  const state = await (storeClient ?? store()).publish(fs.readFileSync(meta.zip), meta.version);
  summary(`${tag}: ${state}. ZIP SHA-256: ${meta.checksum}`);
  return state;
}
function downloadArtifacts(cwd, tag, sourceRunId) {
  const dir = path.join(cwd, 'releases');
  fs.mkdirSync(dir, { recursive: true });
  if (sourceRunId) {
    if (!/^\d+$/.test(sourceRunId)) throw new Error('source_run_id must be numeric.');
    const runInfo = JSON.parse(run('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${sourceRunId}`], cwd));
    if (runInfo.event !== 'workflow_dispatch' || runInfo.head_branch !== 'main' || runInfo.path !== '.github/workflows/release.yml') throw new Error('Recovery artifact must come from a main-branch Release run.');
    run('gh', ['run', 'download', sourceRunId, '--name', `release-${tag}`, '--dir', dir], cwd);
  } else {
    try { run('gh', ['release', 'download', tag, '--pattern', `tidl-${tag.slice(1)}.*`, '--dir', dir], cwd); }
    catch { throw new Error('Original release artifacts unavailable. Resume with source_run_id from the preparation run. Never rebuild this version.'); }
  }
  return dir;
}
async function resume({ cwd = process.cwd(), tag, sourceRunId, dryRun = false, storeClient,
  downloadFn = downloadArtifacts, githubReleaseFn = githubRelease }) {
  validateTag(tag);
  if (!dryRun) requireMain();
  // Never create or force-update tags during recovery.
  git(['fetch', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], cwd);
  downloadFn(cwd, tag, sourceRunId);
  const meta = verifyArtifacts(cwd, tag);
  if (sourceRunId && meta.workflowRunId !== sourceRunId) throw new Error('Recovery workflow run does not match the metadata.');
  if (dryRun) { summary(`Verified ${tag}; dry run performed no publication.`); return; }
  assessStatus(await (storeClient ?? store()).status(), meta.version);
  githubReleaseFn(cwd, tag, meta);
  return publish({ cwd, tag, storeClient });
}
async function main() {
  const args = process.argv.slice(2);
  const operation = args.shift();
  const option = name => {
    const index = args.indexOf(`--${name}`);
    return index < 0 ? undefined : args[index + 1];
  };
  const dryRun = args.includes('--dry-run');
  const tag = option('tag') ?? process.env.RELEASE_TAG;
  switch (operation) {
    case 'prepare': return prepare({ bump: option('bump') ?? process.env.RELEASE_BUMP ?? 'patch', dryRun });
    case 'finalize': if (dryRun) throw new Error('finalize is live-only.'); return finalize({ tag });
    case 'publish': if (dryRun) throw new Error('publish is live-only.'); return publish({ tag });
    case 'resume': return resume({ tag, sourceRunId: option('source-run-id') ?? process.env.SOURCE_RUN_ID, dryRun });
    case 'status': {
      if (tag) validateTag(tag);
      const status = await store().status();
      summary(tag ? `${tag}: ${assessStatus(status, tag.slice(1))}` : JSON.stringify(status, null, 2));
      return;
    }
    default: throw new Error('Use prepare [--bump patch|minor|major] [--dry-run], resume --tag vX.Y.Z, or status.');
  }
}
if (require.main === module) main().catch(error => {
  summary(`Release stopped: ${error.message}`);
  process.exitCode = 1;
});
module.exports = { prepare, finalize, publish, resume, verifyArtifacts, assertRemoteUnchanged, assertTagAbsent, validateTag, requireMain, githubRelease };
