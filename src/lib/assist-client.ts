import { z } from 'zod';
import { itemSchemas, TASKS, type AssistContext, type AssistTask, type Proposal } from './assist';

export const PASSCODE_KEY = 'peregrine-assist-passcode';

const proposalSchema = z.object({ task: z.enum(TASKS), model: z.string().max(200), promptVersion: z.string().max(40), createdAt: z.string().max(40) });

export function readPasscode() {
  try { return sessionStorage.getItem(PASSCODE_KEY) ?? ''; } catch { return ''; }
}
export function storePasscode(value: string) {
  try { value ? sessionStorage.setItem(PASSCODE_KEY, value) : sessionStorage.removeItem(PASSCODE_KEY); } catch { /* private mode: keep in memory only */ }
}

export async function requestProposal(task: AssistTask, context: AssistContext, passcode: string): Promise<Proposal> {
  if (!passcode) throw new Error('Enter the AI assist passcode first.');
  const res = await fetch('/api/assist', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-assist-passcode': passcode },
    body: JSON.stringify({ task, context }),
  });
  const data = await res.json().catch(() => ({})) as { error?: string; proposal?: unknown };
  if (!res.ok) throw new Error(data.error ?? `AI assist failed (${res.status}).`);
  const head = proposalSchema.parse(data.proposal);
  const items = z.array(itemSchemas[head.task]).max(20).parse((data.proposal as { items?: unknown }).items);
  return { ...head, items };
}
