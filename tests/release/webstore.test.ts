import { describe, expect, it, vi } from 'vitest';
const { createWebStore, assessStatus } = require('../../scripts/lib/webstore');
const revision = (version: string, state: string) => ({ state, distributionChannels: [{ crxVersion: version }] });
const response = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
function client(responses: (Response | Error)[]) {
  let elapsed = 0;
  const fetchImpl = vi.fn(async () => {
    const value = responses.shift();
    if (value instanceof Error) throw value;
    if (!value) throw new Error('Unexpected request');
    return value;
  });
  const sleep = vi.fn(async (ms: number) => { elapsed += ms; });
  return { api: createWebStore({ publisherId: 'publisher', extensionId: 'a'.repeat(32), token: 'secret-test-token', fetchImpl, sleep, now: () => elapsed }), fetchImpl, sleep };
}
describe('Chrome Web Store release state', () => {
  it('recognizes already submitted and published versions', () => {
    expect(assessStatus({ publishedItemRevisionStatus: revision('0.1.3', 'PUBLISHED') }, '0.1.3')).toBe('published');
    expect(assessStatus({ submittedItemRevisionStatus: revision('0.1.3', 'PENDING_REVIEW') }, '0.1.3')).toBe('submitted for review');
    expect(assessStatus({ submittedItemRevisionStatus: revision('0.1.3', 'STAGED') }, '0.1.3')).toBe('staged');
  });
  it('blocks conflicting submissions, older versions, and rejected releases', () => {
    expect(() => assessStatus({ submittedItemRevisionStatus: revision('0.1.4', 'PENDING_REVIEW') }, '0.1.3')).toThrow('different');
    expect(() => assessStatus({ publishedItemRevisionStatus: revision('0.1.3.1', 'PUBLISHED') }, '0.1.3')).toThrow('newer');
    expect(() => assessStatus({ submittedItemRevisionStatus: revision('0.1.3', 'REJECTED') }, '0.1.3')).toThrow('rejected');
    expect(() => assessStatus({ takenDown: true }, '0.1.3')).toThrow('taken down');
  });
  it('uploads then submits for automatic publication with review', async () => {
    const { api, fetchImpl } = client([response({}), response({ uploadState: 'SUCCEEDED', crxVersion: '0.1.3' }), response({}), response({ state: 'PENDING_REVIEW' })]);
    expect(await api.publish(Buffer.from('zip'), '0.1.3')).toBe('submitted for review');
    expect(fetchImpl.mock.calls.map((c: any) => c[0])).toEqual([
      expect.stringContaining(':fetchStatus'), expect.stringContaining('/upload/v2/publishers/publisher/items/'),
      expect.stringContaining(':fetchStatus'), expect.stringContaining(':publish'),
    ]);
    expect(JSON.parse((fetchImpl.mock.calls as any)[3][1].body)).toEqual({ publishType: 'DEFAULT_PUBLISH', skipReview: false });
  });
  it('polls asynchronous validation before submitting', async () => {
    const { api, sleep } = client([response({}), response({ uploadState: 'IN_PROGRESS' }), response({ lastAsyncUploadState: 'IN_PROGRESS' }), response({ lastAsyncUploadState: 'SUCCEEDED' }), response({}), response({ state: 'PENDING_REVIEW' })]);
    await api.publish(Buffer.from('zip'), '0.1.3'); expect(sleep.mock.calls).toEqual([[10000], [10000]]);
  });
  it('stops after five minutes of upload processing', async () => {
    const { api, fetchImpl } = client([response({}), response({ uploadState: 'IN_PROGRESS' }), ...Array.from({ length: 30 }, () => response({ lastAsyncUploadState: 'IN_PROGRESS' }))]);
    await expect(api.publish(Buffer.from('zip'), '0.1.3')).rejects.toThrow('timed out');
    expect(fetchImpl.mock.calls.some((c: any) => c[0].endsWith(':publish'))).toBe(false);
  });
  it.each(['FAILED', 'NOT_FOUND', undefined])('does not submit after upload state %s', async uploadState => {
    const { api, fetchImpl } = client([response({}), response({ uploadState })]);
    await expect(api.publish(Buffer.from('zip'), '0.1.3')).rejects.toThrow('validation failed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('rejects a mismatched upload version', async () => {
    const { api } = client([response({}), response({ uploadState: 'SUCCEEDED', crxVersion: '0.1.2' })]);
    await expect(api.publish(Buffer.from('zip'), '0.1.3')).rejects.toThrow('does not match');
  });
  it('does not mutate an already submitted release', async () => {
    const { api, fetchImpl } = client([response({ submittedItemRevisionStatus: revision('0.1.3', 'PENDING_REVIEW') })]);
    expect(await api.publish(Buffer.from('zip'), '0.1.3')).toBe('submitted for review'); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('reconciles a timed-out submission without sending it twice', async () => {
    const { api, fetchImpl } = client([response({}), response({ uploadState: 'SUCCEEDED' }), response({}), new Error('timeout'), response({ submittedItemRevisionStatus: revision('0.1.3', 'PENDING_REVIEW') })]);
    expect(await api.publish(Buffer.from('zip'), '0.1.3')).toBe('submitted for review');
    expect(fetchImpl.mock.calls.filter((c: any) => c[0].endsWith(':publish'))).toHaveLength(1);
  });
  it('does not trust an old upload success after a timed-out POST', async () => {
    const { api, fetchImpl } = client([response({}), new Error('timeout'), response({ lastAsyncUploadState: 'SUCCEEDED' })]);
    await expect(api.publish(Buffer.from('zip'), '0.1.3')).rejects.toThrow('uncertain');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('reports an unconfirmed submission without retrying its POST', async () => {
    const { api, fetchImpl } = client([response({}), response({ uploadState: 'SUCCEEDED' }), response({}), response({}, 500), response({})]);
    await expect(api.publish(Buffer.from('zip'), '0.1.3')).rejects.toThrow('not confirmed');
    expect(fetchImpl.mock.calls.filter((c: any) => c[0].endsWith(':publish'))).toHaveLength(1);
  });
  it('retries read-only rate limits using Retry-After', async () => {
    const { api, sleep } = client([response({}, 429, { 'Retry-After': '2' }), response({})]);
    expect(await api.status()).toEqual({}); expect(sleep).toHaveBeenCalledWith(2000);
  });
  it('does not retry authorization failures or expose the token', async () => {
    const { api, fetchImpl } = client([response({}, 401)]);
    await expect(api.status()).rejects.toThrow('HTTP 401'); expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
