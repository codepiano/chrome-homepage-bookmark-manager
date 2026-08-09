import assert from 'node:assert/strict';
import test from 'node:test';
import { blockedIp, fetchMetadata, MetadataError, parseMetadata, readMetadataHtml } from '../src/metadata.js';

test('blocks private, loopback, and IPv4-mapped IPv6 addresses', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(blockedIp(address), true, `${address} should be blocked`);
  }
  assert.equal(blockedIp('8.8.8.8'), false);
});

test('refuses IPv4-mapped loopback URLs before making a metadata request', async () => {
  await assert.rejects(fetchMetadata('http://[::ffff:127.0.0.1]/'), (error: unknown) =>
    error instanceof MetadataError && error.message === 'Private or loopback addresses cannot be fetched');
});

test('parses metadata and favicon when attributes are in a different order', () => {
  const metadata = parseMetadata(`<!doctype html><head>
    <meta content="A description" name="description">
    <meta content="Open Graph title" property="og:title">
    <link href="/assets/site-icon.png" sizes="32x32" rel="icon">
  </head><title>Document title</title>`, new URL('https://example.com/path/page'));
  assert.deepEqual(metadata, {
    title: 'Open Graph title', description: 'A description', faviconUrl: 'https://example.com/assets/site-icon.png',
  });
});

test('stops reading after the document head instead of rejecting a large body', async () => {
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('<html><head><title>Small head</title></head>'));
      controller.enqueue(encoder.encode('x'.repeat(5 * 1024 * 1024)));
    },
    cancel() { cancelled = true; },
  });
  assert.equal(await readMetadataHtml(body), '<html><head><title>Small head</title></head>');
  assert.equal(cancelled, true);
});
