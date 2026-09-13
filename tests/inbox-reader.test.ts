import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { downloadGmailAttachment, readGmailInbox, type InboxClient, type InboxClientOptions } from '../src/lib/inbox-reader';

const NOW = new Date('2026-09-12T04:00:00.000Z');

type SeedMessage = {
  uid: number;
  envelope?: {
    messageId?: string;
    inReplyTo?: string;
    from?: Array<{ address?: string }>;
    date?: Date | string;
    subject?: string;
  };
  internalDate?: Date;
  headers?: Buffer;
  bodyStructure?: BodyNode;
  text?: string;
  parts?: Record<string, Buffer>;
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

class FakeInboxClient extends EventEmitter implements InboxClient {
  readonly downloads: Array<{ uid: number; part: string; maxBytes?: number }> = [];
  readonly fetches: number[][] = [];
  readonly searches: unknown[] = [];
  readonly opened: Array<{ path: string; readOnly?: boolean }> = [];
  connected = false;
  loggedOut = false;
  closed = false;
  flags = new Set(['\\Seen']);

  constructor(readonly options: InboxClientOptions, readonly seeds: SeedMessage[], readonly searchUids = seeds.map(seed => seed.uid)) { super(); }

  async connect() { this.connected = true; }
  async mailboxOpen(path: string, options?: { readOnly?: boolean }) { this.opened.push({ path, ...options }); }
  async search(query: unknown) { this.searches.push(query); return this.searchUids; }
  async fetchAll(uids: number[]) { this.fetches.push([...uids]); return this.seeds.filter(seed => uids.includes(seed.uid)); }
  async download(uid: number, part: string, options?: { maxBytes?: number }): ReturnType<InboxClient['download']> {
    this.downloads.push({ uid, part, maxBytes: options?.maxBytes });
    const seed = this.seeds.find(seed => seed.uid === uid);
    const binary = seed?.parts?.[part];
    if (binary) {
      const limited = options?.maxBytes ? binary.subarray(0, options.maxBytes) : binary;
      return { meta: { expectedSize: binary.length, contentType: 'application/octet-stream' }, content: Readable.from([limited]) };
    }
    const text = seed?.text ?? '';
    return { meta: { expectedSize: Buffer.byteLength(text), contentType: 'text/plain', charset: 'utf-8' }, content: Readable.from([Buffer.from(text)]) };
  }
  async logout() { this.loggedOut = true; }
  close() { this.closed = true; }

  // If production ever mutates flags, this fake exposes the change through
  // the mailbox state assertion rather than a call-count assertion.
  async messageFlagsAdd(_uid: number, flags: string[]) { flags.forEach(flag => this.flags.add(flag)); return true; }
  async messageDelete() { this.flags.add('\\Deleted'); return true; }
}

function message(overrides: Partial<SeedMessage> & Pick<SeedMessage, 'uid'>): SeedMessage {
  return {
    envelope: {
      messageId: `<msg-${overrides.uid}@example.com>`,
      from: [{ address: 'family@example.com' }],
      date: new Date('2026-09-11T09:00:00.000Z'),
      subject: 'Family reply',
    },
    internalDate: new Date('2026-09-11T09:01:00.000Z'),
    headers: Buffer.from('References: <root@example.com>\r\n\t<prior@example.com>\r\n'),
    bodyStructure: { part: '1', type: 'text/plain', size: 50 },
    text: 'Hello from the family.',
    ...overrides,
  };
}

function readWith(fake: FakeInboxClient, timeoutMs = 1_000) {
  return readGmailInbox(
    { user: 'adviser@example.com', pass: 'app-password', allowedSenders: 'family@example.com, other@example.com' },
    { createClient: () => fake, now: () => NOW, timeoutMs },
  );
}

describe('readGmailInbox', () => {
  afterEach(() => vi.useRealTimers());

  it('returns only exact one-mailbox allowlist matches and keeps the mailbox unchanged', async () => {
    const seeds = [
      message({ uid: 9, internalDate: new Date('2026-08-12T03:59:59Z'), envelope: { messageId: '<too-old@example.com>', from: [{ address: 'family@example.com' }], date: new Date('2026-09-12T03:00:00Z'), subject: 'Old arrival with a recent header' } }),
      message({ uid: 10, envelope: { messageId: '<old@example.com>', from: [{ address: 'family@example.com' }], date: new Date('2026-09-10T09:00:00Z'), subject: 'Older' } }),
      message({ uid: 11, envelope: { messageId: '<spoof@example.com>', from: [{ address: 'family@example.com.evil.test' }], date: new Date('2026-09-11T10:00:00Z'), subject: 'Spoof' } }),
      message({ uid: 12, envelope: { messageId: '<multi@example.com>', from: [{ address: 'family@example.com' }, { address: 'other@example.com' }], date: new Date('2026-09-11T11:00:00Z'), subject: 'Multiple From mailboxes' } }),
      message({
        uid: 13,
        envelope: { messageId: '<reply@example.com>', inReplyTo: '<request@example.com>', from: [{ address: 'Family@Example.com' }], date: new Date('2026-09-11T12:00:00Z'), subject: 'Reply' },
        headers: Buffer.from('References: <root@example.com>\r\n <request@example.com>\r\nReferences: junk <latest@example.com>\r\n'),
        bodyStructure: {
          type: 'multipart/mixed', childNodes: [
            { part: '1', type: 'text/plain', size: 40 },
            { part: '2', type: 'application/pdf', size: 1234, disposition: 'attachment', dispositionParameters: { filename: 'records.pdf' } },
          ],
        },
        text: 'Café records are attached.',
      }),
    ];
    let options: InboxClientOptions | undefined;
    const fake = new FakeInboxClient({} as InboxClientOptions, seeds);

    const result = await readGmailInbox(
      { user: 'adviser@example.com', pass: 'app-password', allowedSenders: 'family@example.com, other@example.com' },
      { createClient: value => { options = value; return fake; }, now: () => NOW, timeoutMs: 1_000 },
    );

    expect(options).toEqual(expect.objectContaining({
      host: 'imap.gmail.com', port: 993, secure: true, logger: false,
      auth: { user: 'adviser@example.com', pass: 'app-password' },
    }));
    expect(fake.opened).toEqual([{ path: 'INBOX', readOnly: true }]);
    expect(fake.searches).toEqual([{
      since: new Date('2026-08-13T04:00:00.000Z'),
      or: [{ from: 'family@example.com' }, { from: 'other@example.com' }],
    }]);
    expect(result.messages).toEqual([
      {
        messageId: '<reply@example.com>', inReplyTo: '<request@example.com>',
        references: ['<root@example.com>', '<request@example.com>', '<latest@example.com>'],
        from: 'Family@Example.com', date: '2026-09-11T12:00:00.000Z', subject: 'Reply',
        text: 'Café records are attached.',
        attachments: [{ filename: 'records.pdf', size: 1234, contentType: 'application/pdf' }],
        textTruncated: false,
      },
      expect.objectContaining({ messageId: '<old@example.com>' }),
    ]);
    expect(fake.downloads).toEqual([
      expect.objectContaining({ uid: 13, part: '1' }),
      expect.objectContaining({ uid: 10, part: '1' }),
    ]);
    expect(fake.downloads.every(download => Number.isFinite(download.maxBytes) && download.maxBytes! <= 100_000)).toBe(true);
    expect(fake.flags).toEqual(new Set(['\\Seen']));
    expect(fake.loggedOut).toBe(true);
    expect(fake.closed).toBe(false);
    expect(Date.parse(result.checkedAt)).not.toBeNaN();
  });

  it('bounds messages, text, references, subjects, filenames, and attachment metadata', async () => {
    const attachments: BodyNode[] = Array.from({ length: 35 }, (_, index) => ({
      part: String(index + 2), type: 'application/octet-stream', size: index + 1,
      disposition: 'attachment', dispositionParameters: { filename: `${'f'.repeat(320)}-${index}` },
    }));
    const refs = Array.from({ length: 105 }, (_, index) => `<ref-${index}@example.com>`).join(' ');
    const seeds = Array.from({ length: 60 }, (_, index) => message({
      uid: index + 1,
      envelope: {
        messageId: `<message-${index}@example.com>`, from: [{ address: 'family@example.com' }],
        date: new Date(NOW.getTime() - (59 - index) * 1_000), subject: 's'.repeat(350),
      },
      internalDate: new Date(NOW.getTime() - (59 - index) * 1_000),
      headers: Buffer.from(`References: ${refs} <${'x'.repeat(1_100)}@example.com>\r\n`),
      bodyStructure: { type: 'multipart/mixed', childNodes: [{ part: '1', type: 'text/plain', size: 90_000 }, ...attachments] },
      text: 'a'.repeat(25_000),
    }));
    const fake = new FakeInboxClient({} as InboxClientOptions, seeds, seeds.map(seed => seed.uid));

    const result = await readWith(fake);

    expect(result.messages).toHaveLength(50);
    expect(fake.fetches).toHaveLength(1);
    expect(fake.fetches[0]).toHaveLength(50);
    expect(result.messages[0].messageId).toBe('<message-59@example.com>');
    expect(result.messages[0].text).toHaveLength(20_000);
    expect(result.messages[0].textTruncated).toBe(true);
    expect(result.messages[0].subject).toHaveLength(300);
    expect(result.messages[0].references).toHaveLength(100);
    expect(result.messages[0].references.every(value => value.length <= 1_000)).toBe(true);
    expect(result.messages[0].attachments).toHaveLength(30);
    expect(result.messages[0].attachments.every(value => value.filename.length <= 300)).toBe(true);
  });

  it('keeps HTML-only mail as metadata with empty text and skips malformed IDs or dates', async () => {
    const invalidDate = message({ uid: 22, envelope: { messageId: '<bad-date@example.com>', from: [{ address: 'family@example.com' }], date: new Date('invalid'), subject: 'Bad date' } });
    const invalidId = message({ uid: 23, envelope: { messageId: 'not-a-message-id', from: [{ address: 'family@example.com' }], date: NOW, subject: 'Bad id' } });
    const html = message({
      uid: 24,
      envelope: { messageId: '<html@example.com>', from: [{ address: 'family@example.com' }], date: NOW.toISOString(), subject: 'HTML only' },
      bodyStructure: { part: '1', type: 'text/html', size: 200 },
      text: '<p>Do not download me</p>',
    });
    const fake = new FakeInboxClient({} as InboxClientOptions, [invalidDate, invalidId, html]);

    const result = await readWith(fake);

    expect(result.messages).toEqual([expect.objectContaining({ messageId: '<html@example.com>', date: NOW.toISOString(), text: '', textTruncated: false })]);
    expect(fake.downloads).toEqual([]);
  });

  it('does not treat text nested inside an attached email as the message body', async () => {
    const attachedEmail = message({
      uid: 25,
      envelope: { messageId: '<attached-email@example.com>', from: [{ address: 'family@example.com' }], date: NOW, subject: 'Attached email only' },
      bodyStructure: {
        type: 'multipart/mixed', childNodes: [{
          part: '2', type: 'message/rfc822', size: 8_000, disposition: 'attachment',
          dispositionParameters: { filename: 'forwarded.eml' },
          childNodes: [{ part: '2.1', type: 'text/plain', size: 500 }],
        }],
      },
      text: 'Private text from inside the attached email.',
    });
    const fake = new FakeInboxClient({} as InboxClientOptions, [attachedEmail]);

    const result = await readWith(fake);

    expect(result.messages).toEqual([expect.objectContaining({
      messageId: '<attached-email@example.com>', text: '',
      attachments: [{ filename: 'forwarded.eml', size: 8_000, contentType: 'message/rfc822' }],
    })]);
    expect(fake.downloads).toEqual([]);
  });

  it('fails safely if the requested body part disappears between listing and download', async () => {
    const fake = new FakeInboxClient({} as InboxClientOptions, [message({ uid: 30 })]);
    fake.download = async () => ({});
    await expect(readWith(fake)).rejects.toMatchObject({ code: 'provider' });
    expect(fake.closed).toBe(true);
  });

  it('handles provider error events without exposing or crashing on provider details', async () => {
    const fake = new FakeInboxClient({} as InboxClientOptions, []);
    fake.connect = async () => {
      fake.connected = true;
      fake.emit('error', new Error('AUTHENTICATIONFAILED app-password'));
    };

    await expect(readWith(fake)).resolves.toEqual({ messages: [], checkedAt: NOW.toISOString() });
    expect(fake.loggedOut).toBe(true);
  });

  it('closes the connection when the total deadline expires', async () => {
    vi.useFakeTimers();
    const fake = new FakeInboxClient({} as InboxClientOptions, []);
    fake.connect = () => new Promise<void>(() => {});

    const pending = readWith(fake, 20);
    const rejection = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(21);

    await rejection;
    expect(fake.closed).toBe(true);
    expect(fake.loggedOut).toBe(false);
  });
});

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
const multipart: BodyNode = { type: 'multipart/mixed', childNodes: [
  { part: '1', type: 'text/plain', size: 20 },
  { part: '2', type: 'image/jpeg', size: JPEG.length, disposition: 'attachment', dispositionParameters: { filename: 'statement.jpg' } },
  { part: '3', type: 'application/zip', size: 10, disposition: 'attachment', dispositionParameters: { filename: 'x.zip' } },
] };
function downloadWith(fake: FakeInboxClient, messageId = '<msg-7@example.com>', index = 0) {
  return downloadGmailAttachment(
    { user: 'adviser@example.com', pass: 'app-password', allowedSenders: 'family@example.com' }, messageId, index,
    { createClient: () => fake, now: () => NOW, timeoutMs: 1_000 },
  );
}

describe('downloadGmailAttachment', () => {
  // Attachment indexes count attachments only: part 2 (jpeg) is index 0, part 3 (zip) is index 1.
  it('finds the message by id, checks the sender, and returns the nth attachment bytes read-only', async () => {
    const fake = new FakeInboxClient({} as InboxClientOptions, [message({ uid: 7, bodyStructure: multipart, parts: { '2': JPEG } })]);
    const result = await downloadWith(fake);
    expect(result).toMatchObject({ filename: 'statement.jpg', contentType: 'image/jpeg' });
    expect(Buffer.compare(result.bytes, JPEG)).toBe(0);
    expect(fake.searches[0]).toEqual({ header: { 'message-id': '<msg-7@example.com>' } });
    expect(fake.downloads).toEqual([{ uid: 7, part: '2', maxBytes: 8 * 1024 * 1024 + 1 }]);
    expect(fake.opened).toEqual([{ path: 'INBOX', readOnly: true }]);
    expect(fake.loggedOut).toBe(true);
    expect([...fake.flags]).toEqual(['\\Seen']);
  });
  it('not_found when the id is unknown, the sender is not allowed, or the message is too old', async () => {
    const empty = new FakeInboxClient({} as InboxClientOptions, [], []);
    await expect(downloadWith(empty)).rejects.toMatchObject({ code: 'not_found' });
    const stranger = new FakeInboxClient({} as InboxClientOptions, [message({ uid: 7, bodyStructure: multipart, parts: { '2': JPEG }, envelope: { messageId: '<msg-7@example.com>', from: [{ address: 'stranger@example.com' }], date: new Date('2026-09-11T09:00:00.000Z') } })]);
    await expect(downloadWith(stranger)).rejects.toMatchObject({ code: 'not_found' });
    const old = new FakeInboxClient({} as InboxClientOptions, [message({ uid: 7, bodyStructure: multipart, parts: { '2': JPEG }, internalDate: new Date('2026-07-01T00:00:00.000Z') })]);
    await expect(downloadWith(old)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('not_found for an attachment index that does not exist', async () => {
    const fake = new FakeInboxClient({} as InboxClientOptions, [message({ uid: 7, bodyStructure: multipart, parts: { '2': JPEG } })]);
    await expect(downloadWith(fake, '<msg-7@example.com>', 5)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('unsupported_type for a declared type outside the allow-list, before downloading', async () => {
    const fake = new FakeInboxClient({} as InboxClientOptions, [message({ uid: 7, bodyStructure: multipart, parts: { '3': Buffer.alloc(10) } })]);
    await expect(downloadWith(fake, '<msg-7@example.com>', 1)).rejects.toMatchObject({ code: 'unsupported_type' });
    expect(fake.downloads).toEqual([]);
  });
  it('too_large when the declared size or the stream exceeds 8 MB', async () => {
    const big: BodyNode = { type: 'multipart/mixed', childNodes: [{ part: '2', type: 'image/png', size: 9 * 1024 * 1024, disposition: 'attachment', dispositionParameters: { filename: 'huge.png' } }] };
    const declared = new FakeInboxClient({} as InboxClientOptions, [message({ uid: 7, bodyStructure: big })]);
    await expect(downloadWith(declared, '<msg-7@example.com>', 0)).rejects.toMatchObject({ code: 'too_large' });
    expect(declared.downloads).toEqual([]);
    const lying: BodyNode = { type: 'multipart/mixed', childNodes: [{ part: '2', type: 'image/png', size: 10, disposition: 'attachment', dispositionParameters: { filename: 'huge.png' } }] };
    const stream = new FakeInboxClient({} as InboxClientOptions, [message({ uid: 7, bodyStructure: lying, parts: { '2': Buffer.alloc(8 * 1024 * 1024 + 1) } })]);
    await expect(downloadWith(stream, '<msg-7@example.com>', 0)).rejects.toMatchObject({ code: 'too_large' });
  });
  it('times out and closes the connection', async () => {
    const fake = new FakeInboxClient({} as InboxClientOptions, [message({ uid: 7, bodyStructure: multipart, parts: { '2': JPEG } })]);
    fake.connect = () => new Promise(() => {});
    await expect(downloadWith(fake)).rejects.toMatchObject({ code: 'timeout' });
    expect(fake.closed).toBe(true);
  });
});
