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
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

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
    expect(proposal).toMatchObject({ task: 'follow_up', model: 'vendor/kimi-test', promptVersion: 'assist-2', items: [{ text: 'Please send the July statement.' }] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer nvapi-test');
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ model: 'vendor/kimi-test', temperature: 0.1, max_tokens: 1500 });
    expect(sent.reasoning_effort).toBeUndefined();
    expect(sent.messages[0].role).toBe('system');
  });
  it('uses Kimi K3 low reasoning effort and a larger bounded output allowance', async () => {
    vi.stubEnv('NVIDIA_NIM_MODEL', 'moonshotai/kimi-k3');
    const fetchMock = vi.fn().mockResolvedValue(nimReply('{"items":[{"text":"Please send the July statement.","basis":["issuer A"]}]}'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await call(good);

    expect(res.status).toBe(200);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent).toMatchObject({
      model: 'moonshotai/kimi-k3', temperature: 1, max_tokens: 4096,
      reasoning_effort: 'low', stream: false,
    });
  });
  it('disables Lightning thinking to reserve the response budget for a validated proposal', async () => {
    vi.stubEnv('NVIDIA_NIM_MODEL', 'nvidia/nemotron-3.5-lightning-30b-a3b');
    const fetchMock = vi.fn().mockResolvedValue(nimReply('{"items":[{"text":"Please provide support for the remaining $1,000.","basis":["differenceAud 1000.00"]}]}'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await call(good);
    expect(res.status).toBe(200);
    expect((await res.json()).proposal.items[0].text).toContain('$1,000');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: 'nvidia/nemotron-3.5-lightning-30b-a3b', temperature: 0.1, max_tokens: 1500,
      chat_template_kwargs: { enable_thinking: false }, stream: false,
    });
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
    const fetchMock = vi.fn().mockResolvedValue(new Response('upstream down', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await call(good);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/model service/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('does not retry an upstream 429 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await call(good);

    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('does not retry or expose a network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('socket failed with secret-provider-detail'));
    vi.stubGlobal('fetch', fetchMock);

    const response = await call(good);
    const responseBody = JSON.stringify(await response.json());

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(responseBody).toMatch(/model service request failed/i);
    expect(responseBody).not.toContain('secret-provider-detail');
  });
  it('shares one 54-second deadline across an unusable reply and its retry', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => {
        setTimeout(() => resolve(nimReply('not JSON')), 30_000);
      }))
      .mockImplementationOnce((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = call(good);
    const result = expect(pending).resolves.toMatchObject({ status: 502 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(24_000);

    await result;
    expect(fetchMock.mock.calls[0][1].signal).toBe(fetchMock.mock.calls[1][1].signal);
  });
});
