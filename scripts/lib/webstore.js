const API = 'https://chromewebstore.googleapis.com';
const ACTIVE = new Set(['PENDING_REVIEW', 'STAGED']);
const PUBLISHED = new Set(['PUBLISHED', 'PUBLISHED_TO_TESTERS']);
const versions = revision => (revision?.distributionChannels ?? []).map(c => c.crxVersion);
function compareVersions(a, b) {
  // The store also supports historical four-component Chrome versions.
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  if (![a, b].every(v => /^\d+(\.\d+){0,3}$/.test(v))) throw new Error('Invalid store version.');
  for (let i = 0; i < 4; i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta) return Math.sign(delta);
  }
  return 0;
}
function assessStatus(status, version) {
  if (status.takenDown) throw new Error('Store item is taken down. Check the developer dashboard.');
  const published = status.publishedItemRevisionStatus;
  const submitted = status.submittedItemRevisionStatus;
  if (PUBLISHED.has(published?.state) && versions(published).includes(version)) return 'published';
  if (ACTIVE.has(submitted?.state)) {
    if (versions(submitted).includes(version)) return submitted.state === 'STAGED' ? 'staged' : 'submitted for review';
    throw new Error('A different version is awaiting review/publication; it will not be replaced.');
  }
  if (versions(published).some(v => compareVersions(version, v) <= 0)) throw new Error('Release version must be newer than the published store version.');
  if (versions(submitted).includes(version) && ['REJECTED', 'CANCELLED'].includes(submitted.state)) {
    throw new Error('This submission was rejected or cancelled. Inspect the dashboard before releasing a corrected version.');
  }
  return 'ready';
}
function createWebStore({ publisherId, extensionId, token, fetchImpl = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  if (!publisherId || !/^[a-zA-Z0-9_-]+$/.test(publisherId)) throw new Error('Missing or invalid CWS_PUBLISHER_ID.');
  if (!/^[a-p]{32}$/.test(extensionId ?? '')) throw new Error('Missing or invalid CWS_EXTENSION_ID.');
  if (!token) throw new Error('Missing CWS_ACCESS_TOKEN; authenticate the publisher service account.');
  const resource = `publishers/${publisherId}/items/${extensionId}`;
  async function request(url, { method = 'GET', body, contentType = 'application/json' } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetchImpl(url, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
        ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(60000),
      });
      if (method === 'GET' && (response.status === 429 || response.status >= 500) && attempt < 2) {
        const delay = Number(response.headers.get('Retry-After'));
        await sleep(Number.isFinite(delay) && delay > 0 ? Math.min(delay, 30) * 1000 : (attempt + 1) * 1000);
        continue;
      }
      if (!response.ok) {
        // Do not print request headers, tokens, or arbitrary upstream bodies.
        throw new Error(`Chrome Web Store ${method} failed (HTTP ${response.status}). Check the dashboard and workflow configuration.`);
      }
      return response.json();
    }
  }
  const status = () => request(`${API}/v2/${resource}:fetchStatus`);
  async function upload(zip, version) {
    let result;
    try { result = await request(`${API}/upload/v2/${resource}:upload`, { method: 'POST', body: zip, contentType: 'application/zip' }); }
    catch (error) {
      // fetchStatus has no draft checksum/version binding. An old SUCCEEDED
      // state is not proof that this timed-out upload succeeded.
      const observed = await status();
      const state = assessStatus(observed, version);
      if (state !== 'ready') return state;
      throw new Error(`${error.message} Upload outcome is uncertain; inspect the dashboard, then resume with the original ZIP. No submission was attempted.`);
    }
    if (result.crxVersion && result.crxVersion !== version) throw new Error('Store upload version does not match the ZIP.');
    let state = result.uploadState;
    const deadline = now() + 5 * 60 * 1000;
    while (state === 'IN_PROGRESS' || state === 'UPLOAD_IN_PROGRESS') {
      if (now() >= deadline) throw new Error('Upload validation timed out. Resume with the original release; no submission was attempted.');
      await sleep(10000);
      state = (await status()).lastAsyncUploadState;
    }
    if (state !== 'SUCCEEDED') throw new Error(`Upload validation failed (${state ?? 'missing status'}). No submission was attempted.`);
    return 'uploaded';
  }
  async function submit(version) {
    const before = assessStatus(await status(), version);
    if (before !== 'ready') return before;
    try {
      const result = await request(`${API}/v2/${resource}:publish`, {
        method: 'POST', body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', skipReview: false }),
      });
      if (PUBLISHED.has(result.state)) return 'published';
      if (result.state === 'PENDING_REVIEW') return 'submitted for review';
      throw new Error(`Unexpected submission state: ${result.state}`);
    } catch (error) {
      const after = assessStatus(await status(), version);
      if (after !== 'ready') return after;
      throw new Error(`${error.message} Submission was not confirmed. Check status before resuming; it was not retried.`);
    }
  }
  async function publish(zip, version) {
    const state = assessStatus(await status(), version);
    if (state !== 'ready') return state;
    const uploaded = await upload(zip, version);
    return uploaded === 'uploaded' ? submit(version) : uploaded;
  }
  return { status, upload, submit, publish };
}
module.exports = { createWebStore, assessStatus, compareVersions };
