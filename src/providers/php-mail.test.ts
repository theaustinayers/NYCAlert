import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMailBody } from './php-mail.js';

describe('PHP mail MIME encoding', () => {
  it('wraps long UTF-8 email bodies before DKIM signing without losing content', () => {
    const message = {
      text: 'Hello café →\nVerify: https://example.test/#verify=synthetic\n' + 'x'.repeat(2_000),
      html: '<html><body>' + '<p>News &amp; café →</p>'.repeat(500) + '</body></html>'
    };
    const { boundary, body } = buildMailBody(message);
    assert.equal(/[^\x00-\x7f]/.test(body), false, 'SMTP body must be 7-bit safe');
    assert.ok(body.split('\r\n').every((line) => Buffer.byteLength(line) <= 76));
    assert.equal(body.replaceAll('\r\n', '').includes('\n'), false);
    const parts = body.split(`--${boundary}`).slice(1, -1);
    assert.equal(parts.length, 2);
    for (const [index, part] of parts.entries()) {
      const [headers, encoded] = part.split('\r\n\r\n');
      assert.match(headers!, /Content-Transfer-Encoding: base64/);
      const original = index === 0 ? message.text : message.html;
      assert.equal(Buffer.from(encoded!, 'base64').toString('utf8'), original.replace(/\r\n|\r|\n/g, '\r\n'));
    }
    assert.ok(body.endsWith(`--${boundary}--\r\n`));
  });

  it('handles empty alternatives and uses distinct MIME boundaries', () => {
    const first = buildMailBody({ text: '', html: '' });
    const second = buildMailBody({ text: '', html: '' });
    assert.notEqual(first.boundary, second.boundary);
    assert.equal(first.body.split('Content-Transfer-Encoding: base64').length - 1, 2);
    assert.ok(first.body.endsWith(`--${first.boundary}--\r\n`));
  });
});