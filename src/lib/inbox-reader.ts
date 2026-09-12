import { ImapFlow } from 'imapflow';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_MESSAGES = 50;
const MAX_TEXT_LENGTH = 20_000;
const MAX_TEXT_BYTES = MAX_TEXT_LENGTH * 4 + 4;
const MAX_ATTACHMENTS = 30;
const MAX_REFERENCES = 100;
const MAX_HEADER_BYTES = 128 * 1_024;
const DEFAULT_TIMEOUT_MS = 24_000;

export type InboxClientOptions = {
  host: 'imap.gmail.com';
  port: 993;
  secure: true;
  logger: false;
  disableAutoIdle: true;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  auth: { user: string; pass: string };
};

type Address = { address?: string };
type Envelope = {
  messageId?: string;
  inReplyTo?: string;
  from?: Address[];
  date?: Date | string;
  subject?: string;
};

type BodyNode = {
  part?: string;
  type: string;
  size?: number;
  disposition?: string;
  parameters?: Record<string, string>;
  dispositionParameters?: Record<string, string>;
  childNodes?: BodyNode[];
};

type FetchedMessage = {
  uid: number;
  envelope?: Envelope;
  internalDate?: Date | string;
  headers?: Buffer;
  bodyStructure?: BodyNode;
};

export interface InboxClient {
  on?(event: 'error', listener: (error: unknown) => void): unknown;
  connect(): Promise<void>;
  mailboxOpen(path: string, options?: { readOnly?: boolean }): Promise<unknown>;
  search(query: unknown, options?: { uid?: boolean }): Promise<number[] | false | undefined>;
  fetchAll(uids: number[], query: unknown, options?: { uid?: boolean }): Promise<FetchedMessage[]>;
  download(uid: number, part: string, options?: { uid?: boolean; maxBytes?: number; chunkSize?: number }): Promise<{
    meta?: { expectedSize?: number; contentType?: string; charset?: string };
    content?: NodeJS.ReadableStream & { destroy?: () => void };
  }>;
  logout(): Promise<void>;
  close(): void;
}

export type InboxMessage = {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  from: string;
  date: string;
  subject: string;
  text: string;
  attachments: Array<{ filename: string; size: number; contentType: string }>;
  textTruncated: boolean;
};

export type InboxResult = { messages: InboxMessage[]; checkedAt: string };

export class InboxReadError extends Error {
  constructor(readonly code: 'configuration' | 'provider' | 'timeout') {
    super(code === 'timeout' ? 'The inbox check timed out.' : code === 'configuration' ? 'Inbox access is not configured.' : 'The inbox could not be checked.');
    this.name = 'InboxReadError';
  }
}

type ReaderDependencies = {
  createClient?: (options: InboxClientOptions) => InboxClient;
  now?: () => Date;
  timeoutMs?: number;
};

type ReaderConfig = { user: string; pass: string; allowedSenders: string };

function allowedAddresses(raw: string) {
  return [...new Set(raw.split(',').map(value => value.trim().toLowerCase()).filter(value => value.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(value)))];
}

function bounded(value: unknown, limit: number) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function validMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1_000 && /^<[^<>\s@]+@[^<>\s@]+>$/.test(value.trim());
}

function parsedHeaderValues(headers: Buffer | undefined, name: string) {
  if (!headers?.length) return [];
  const unfolded = headers.subarray(0, MAX_HEADER_BYTES).toString('latin1').replace(/\r?\n[ \t]+/g, ' ');
  const prefix = `${name.toLowerCase()}:`;
  return unfolded.split(/\r?\n/).filter(line => line.toLowerCase().startsWith(prefix)).map(line => line.slice(prefix.length).trim());
}

function messageIds(values: string[]) {
  const output: string[] = [];
  for (const value of values) {
    for (const match of value.matchAll(/<[^<>\s@]+@[^<>\s@]+>/g)) {
      if (validMessageId(match[0]) && !output.includes(match[0])) output.push(match[0]);
      if (output.length === MAX_REFERENCES) return output;
    }
  }
  return output;
}

function inspectStructure(root: BodyNode | undefined) {
  const attachments: InboxMessage['attachments'] = [];
  let textPart: string | null = null;
  if (!root) return { attachments, textPart };

  const pending = [root];
  let inspected = 0;
  while (pending.length && inspected < 500) {
    const node = pending.shift()!;
    inspected += 1;
    const type = bounded(node.type, 200).toLowerCase();
    const disposition = bounded(node.disposition, 50).toLowerCase();
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
    const topType = type.split('/')[0];
    const isAttachment = disposition === 'attachment' || Boolean(filename) || (topType !== 'text' && topType !== 'multipart' && !disposition);

    if (isAttachment && attachments.length < MAX_ATTACHMENTS) {
      attachments.push({
        filename: bounded(filename || 'attachment', 300),
        size: Number.isFinite(node.size) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(node.size!))) : 0,
        contentType: type || 'application/octet-stream',
      });
    }

    if (!textPart && type === 'text/plain' && !isAttachment && disposition !== 'attachment') textPart = node.part || '1';
    if (!isAttachment && node.childNodes?.length) pending.push(...node.childNodes);
  }
  return { attachments, textPart };
}

async function boundedText(stream: NodeJS.ReadableStream & { destroy?: () => void }) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let byteLimited = false;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = MAX_TEXT_BYTES - bytes;
    if (chunk.length >= remaining) {
      chunks.push(chunk.subarray(0, remaining));
      bytes += remaining;
      byteLimited = true;
      stream.destroy?.();
      break;
    }
    chunks.push(chunk);
    bytes += chunk.length;
  }

  const decoded = Buffer.concat(chunks, bytes).toString('utf8');
  let text = decoded.slice(0, MAX_TEXT_LENGTH);
  if (text.length && /[\uD800-\uDBFF]/.test(text.at(-1)!)) text = text.slice(0, -1);
  return { text, truncated: byteLimited || decoded.length > MAX_TEXT_LENGTH };
}

function messageTime(message: FetchedMessage) {
  const date = message.envelope?.date;
  const timestamp = date instanceof Date ? date.getTime() : Date.parse(date ?? '');
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function receivedTime(message: FetchedMessage) {
  const timestamp = message.internalDate instanceof Date ? message.internalDate.getTime() : Date.parse(message.internalDate ?? '');
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

async function collectMessages(client: InboxClient, senders: string[], now: Date): Promise<InboxMessage[]> {
  const since = new Date(now.getTime() - THIRTY_DAYS_MS);
  const senderQuery = senders.length === 1 ? { from: senders[0] } : { or: senders.map(from => ({ from })) };
  const found = await client.search({ since, ...senderQuery }, { uid: true });
  if (!Array.isArray(found) || found.length === 0) return [];

  const uids = [...new Set(found.filter(uid => Number.isSafeInteger(uid) && uid > 0))].sort((a, b) => b - a).slice(0, MAX_MESSAGES);
  if (!uids.length) return [];
  const fetched = await client.fetchAll(uids, {
    envelope: true,
    internalDate: true,
    bodyStructure: true,
    headers: ['In-Reply-To', 'References'],
  }, { uid: true });

  const allowed = new Set(senders);
  const selected = fetched
    .filter(message => {
      const from = message.envelope?.from;
      return from?.length === 1 && typeof from[0].address === 'string' && from[0].address.length <= 320 && allowed.has(from[0].address.trim().toLowerCase());
    })
    .filter(message => receivedTime(message) >= since.getTime())
    .filter(message => validMessageId(message.envelope?.messageId) && messageTime(message) !== Number.NEGATIVE_INFINITY)
    .sort((a, b) => receivedTime(b) - receivedTime(a) || b.uid - a.uid)
    .slice(0, MAX_MESSAGES);

  const output: InboxMessage[] = [];
  for (const message of selected) {
    const envelope = message.envelope!;
    const date = new Date(messageTime(message));
    const headerReplyIds = messageIds(parsedHeaderValues(message.headers, 'In-Reply-To'));
    const envelopeReplyId = validMessageId(envelope.inReplyTo) ? envelope.inReplyTo.trim() : null;
    const { attachments, textPart } = inspectStructure(message.bodyStructure);
    let text = '';
    let textTruncated = false;
    if (textPart) {
      const downloaded = await client.download(message.uid, textPart, { uid: true, maxBytes: MAX_TEXT_BYTES, chunkSize: 16 * 1_024 });
      if (!downloaded.content) throw new InboxReadError('provider');
      ({ text, truncated: textTruncated } = await boundedText(downloaded.content));
    }
    output.push({
      messageId: envelope.messageId!.trim(),
      inReplyTo: headerReplyIds[0] ?? envelopeReplyId,
      references: messageIds(parsedHeaderValues(message.headers, 'References')),
      from: envelope.from![0].address!.trim(),
      date: date.toISOString(),
      subject: bounded(envelope.subject, 300),
      text,
      attachments,
      textTruncated,
    });
  }
  return output;
}

export async function readGmailInbox(config: ReaderConfig, dependencies: ReaderDependencies = {}): Promise<InboxResult> {
  const senders = allowedAddresses(config.allowedSenders);
  if (!config.user || !config.pass || !senders.length) throw new InboxReadError('configuration');

  const now = dependencies.now?.() ?? new Date();
  const checkedAt = Number.isFinite(now.getTime()) ? now.toISOString() : new Date().toISOString();
  const options: InboxClientOptions = {
    host: 'imap.gmail.com', port: 993, secure: true, logger: false, disableAutoIdle: true,
    auth: { user: config.user, pass: config.pass }, connectionTimeout: 8_000, greetingTimeout: 8_000, socketTimeout: 15_000,
  };
  const client = dependencies.createClient?.(options) ?? new ImapFlow(options);
  client.on?.('error', () => {
    // ImapFlow reports failures through the awaited operation as well. Keep the
    // EventEmitter channel handled without logging provider or credential detail.
  });
  const timeoutMs = Math.min(Math.max(1, dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS), DEFAULT_TIMEOUT_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const operation = async () => {
    await client.connect();
    await client.mailboxOpen('INBOX', { readOnly: true });
    const messages = await collectMessages(client, senders, new Date(checkedAt));
    await client.logout();
    return { messages, checkedAt };
  };

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      client.close();
      reject(new InboxReadError('timeout'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(), deadline]);
  } catch (error) {
    client.close();
    if (error instanceof InboxReadError) throw error;
    throw new InboxReadError('provider');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
