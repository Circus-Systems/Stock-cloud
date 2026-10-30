import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { secSource, columnsToRefs, padCik } from '../src/sources/sec';
import type { Holding, SourceContext } from '../src/types';

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'sec_submissions_AAPL.json'), 'utf8'));
const aapl: Holding = { ticker: 'AAPL', exchange: 'XNAS', sources: ['sec'], cik: '320193' };

function ctxWith(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, extra: Partial<SourceContext> = {}): SourceContext {
  return { fetch: async (u, i) => handler(u, i), now: () => new Date('2026-10-30T10:00:00Z'), secUserAgent: 'test-agent', ...extra };
}

describe('sec source', () => {
  it('pads CIKs', () => {
    expect(padCik('320193')).toBe('0000320193');
    expect(padCik('0000320193')).toBe('0000320193');
  });

  it('converts submission columns into refs', () => {
    const refs = columnsToRefs(fixture.filings.recent, aapl);
    expect(refs).toHaveLength(1000);
    const r = refs[0];
    expect(r.id).toBe('0001140361-26-041201');
    expect(r.date).toBe('2026-10-29');
    expect(r.form).toBe('4');
    expect(r.url).toBe('https://www.sec.gov/Archives/edgar/data/320193/000114036126041201/xslF345X06/form4.xml');
    const tenK = refs.find((x) => x.form === '10-K');
    expect(tenK).toBeDefined();
    expect(tenK!.url).toMatch(/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/320193\/\d{18}\/aapl-\d{8}\.htm$/);
  });

  it('lists recent then older files in full mode, with the SEC user-agent', async () => {
    const seen: string[] = [];
    const ctx = ctxWith((url, init) => {
      seen.push(url);
      expect((init?.headers as Record<string, string>)['user-agent']).toBe('test-agent');
      if (url.endsWith('CIK0000320193.json')) return new Response(JSON.stringify(fixture), { headers: { 'content-type': 'application/json' } });
      if (url.endsWith('CIK0000320193-submissions-001.json')) {
        const cols = { accessionNumber: ['0000320193-94-000001'], filingDate: ['1994-01-26'], form: ['10-Q'], primaryDocument: [''] };
        return new Response(JSON.stringify(cols), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('nope', { status: 404 });
    });
    const p1 = await secSource.list(aapl, 'full', undefined, ctx);
    expect(p1.refs).toHaveLength(1000);
    expect(p1.nextCursor).toBe('file:0:CIK0000320193-submissions-001.json');
    const p2 = await secSource.list(aapl, 'full', p1.nextCursor, ctx);
    expect(p2.refs).toHaveLength(1);
    expect(p2.refs[0].url).toBe('https://www.sec.gov/Archives/edgar/data/320193/000032019394000001/0000320193-94-000001.txt');
    expect(p2.nextCursor).toBeUndefined();
    const recent = await secSource.list(aapl, 'recent', undefined, ctx);
    expect(recent.nextCursor).toBeUndefined();
    expect(seen).toHaveLength(3);
  });

  it('downloads the primary document into a dated key', async () => {
    const refs = columnsToRefs(fixture.filings.recent, aapl);
    const tenK = refs.find((x) => x.form === '10-K')!;
    const ctx = ctxWith(() => new Response('<html>10-K</html>', { headers: { 'content-type': 'text/html' } }));
    const objs = await secSource.download(tenK, ctx);
    expect(objs).toHaveLength(1);
    expect(objs[0].key).toMatch(/^sec\/AAPL\/\d{4}\/\d{4}-\d{2}-\d{2}_0000320193-\d{2}-\d{6}_10-K_aapl-\d{8}\.htm$/);
    expect(objs[0].contentType).toBe('text/html');
  });

  it('names stylesheet-rendered XBRL forms .html and can add the full submission', async () => {
    const refs = columnsToRefs(fixture.filings.recent, aapl);
    const form4 = refs[0];
    const ctx = ctxWith((url) =>
      url.endsWith('.txt')
        ? new Response('full text', { headers: { 'content-type': 'text/plain' } })
        : new Response('<html>form 4</html>', { headers: { 'content-type': 'text/html' } }),
      { secFullSubmission: true },
    );
    const objs = await secSource.download(form4, ctx);
    expect(objs).toHaveLength(2);
    expect(objs[0].key).toBe('sec/AAPL/2026/2026-10-29_0001140361-26-041201_4_form4.html');
    expect(objs[1].key).toBe('sec/AAPL/2026/2026-10-29_0001140361-26-041201_4_full-submission.txt');
  });

  it('throws on non-200 so the job is retried', async () => {
    const refs = columnsToRefs(fixture.filings.recent, aapl);
    const ctx = ctxWith(() => new Response('blocked', { status: 403 }));
    await expect(secSource.download(refs[0], ctx)).rejects.toThrow(/HTTP 403/);
  });
});
