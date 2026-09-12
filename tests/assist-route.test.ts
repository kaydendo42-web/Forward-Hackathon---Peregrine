import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../src/app/api/assist/route';
import { buildContext } from '../src/lib/assist';
import * as workflow from '../src/core/workflow';
import { baseline } from './fixtures';

const state = workflow.startSeason(workflow.importBaseline(workflow.createWorkspace(), baseline), 'alex-taylor');
const body = JSON.stringify({ task: 'follow_up', context: buildContext(state.requests[0], baseline) });
const good = { 'x-assist-passcode': 'open-sesame', 'sec-fetch-site': 'same-origin' };

function call(headers: Record<string, string>, payload = body) {
  return POST(new Request('http://localhost/api/assist', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload }));
}
function nimReply(content: string, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status, headers: { 'content-type': 'application/json' } });
}

describe('POST /api/assist', () => {
  beforeEach(() => {
    vi.stubEnv('NVIDIA_NIM_API_KEY', 'nvapi-test');
    vi.stubEnv('NVIDIA_NIM_MODEL', 'vendor/kimi-test');
    vi.stubEnv('AI_ASSIST_PASSCODE', 'open-sesame');
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('503 when the server is not configured, before checking anything else', async () => {
    vi.stubEnv('NVIDIA_NIM_API_KEY', '');
    const res = await call({});
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not configured/i);
  });
  it('401 on a missing or wrong passcode', async () => {
    expect((await call({ 'sec-fetch-site': 'same-origin' })).status).toBe(401);
    expect((await call({ ...good, 'x-assist-passcode': 'open-sesam' })).status).toBe(401);
  });
  it('403 when the browser reports a cross-site caller', async () => {
    expect((await call({ ...good, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });
  it('400 on a malformed body', async () => {
    expect((await call(good, '{"task":"nope"}')).status).toBe(400);
    expect((await call(good, 'not json')).status).toBe(400);
  });
  it('200 with a proposal; sends bearer key, model and low temperature to NIM', async () => {
    const fetchMock = vi.fn().mockResolvedValue(nimReply('{"items":[{"text":"Please send the July statement.","basis":["issuer A"]}]}'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await call(good);
    expect(res.status).toBe(200);
    const { proposal } = await res.json();
    expect(proposal).toMatchObject({ task: 'follow_up', model: 'vendor/kimi-test', promptVersion: 'assist-1', items: [{ text: 'Please send the July statement.' }] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer nvapi-test');
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ model: 'vendor/kimi-test', temperature: 0.1 });
    expect(sent.messages[0].role).toBe('system');
  });
  it('502 after one retry when the model keeps returning unusable output', async () => {
    const fetchMock = vi.fn().mockResolvedValue(nimReply('I cannot help with that.'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await call(good);
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messages.at(-1).content).toMatch(/only the JSON object/i);
  });
  it('502 when NIM itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('upstream down', { status: 500 })));
    const res = await call(good);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/model service/i);
  });
});
