import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { BroadcastifyApiProvider, createBroadcastifyJwt, normalizeLiveCall, parseFeedMap } from './broadcastify.js';

describe('parseFeedMap', () => {
  it('parses a JSON array of approved feed mappings', () => {
    const parsed = parseFeedMap('[{"playlistUuid":"abc-123","borough":"Brooklyn","agency":"FDNY"}]');
    assert.deepEqual(parsed, [{ playlistUuid: 'abc-123', borough: 'Brooklyn', agency: 'FDNY' }]);
    assert.deepEqual(parseFeedMap('[{"playlistUuid":"nypd-citywide","borough":"Citywide","agency":"NYPD"}]'), [
      { playlistUuid: 'nypd-citywide', borough: 'Citywide', agency: 'NYPD' }
    ]);
  });
});

describe('normalizeLiveCall', () => {
  it('normalizes feed IDs and times across common Broadcastify payload names', () => {
    const normalized = normalizeLiveCall({
      feed_id: '3210',
      groupId: 'fdny-dispatch',
      sdescr: 'Engine 42',
      ts: '1729400000',
      lastPos: '1729400001'
    });

    assert.equal(normalized.callId, 'fdny-dispatch:1729400000');
    assert.equal(normalized.position, 1729400000);
    assert.equal(normalized.callText, 'Engine 42');
    assert.ok(normalized.occurredAt instanceof Date);
  });

  it('uses the url field returned by the live Calls API as the audio URL', () => {
    const normalized = normalizeLiveCall({
      groupId: 'fdny-1',
      ts: 1_729_400_000,
      url: 'https://api.bcfy.io/calls/recording/example.mp3'
    });

    assert.equal(normalized.audioUrl, 'https://api.bcfy.io/calls/recording/example.mp3');
  });

  it('extracts Broadcastify-provided transcription and group display name', () => {
    const normalized = normalizeLiveCall({
      groupId: 'fdny-1',
      ts: 1_729_400_000,
      transcription: 'Engine 12 responding to 123 Main Street.',
      display: 'FDNY MN Dispatch'
    });

    assert.equal(normalized.transcription, 'Engine 12 responding to 123 Main Street.');
    assert.equal(normalized.groupName, 'FDNY MN Dispatch');
  });
});

describe('BroadcastifyApiProvider', () => {
  it('requests the configured playlist, attaches the call media URL and advances from response calls', async () => {
    let requestedUrl = '';
    let authorization = '';
    const provider = new BroadcastifyApiProvider(
      'https://api.bcfy.io',
      'key-id',
      'issuer-id',
      'test-secret',
      [{ playlistUuid: 'playlist-uuid', borough: 'Manhattan', agency: 'FDNY' }],
      async (input, init) => {
        requestedUrl = String(input);
        authorization = new Headers(init?.headers).get('authorization') ?? '';
        return new Response(JSON.stringify({
          calls: [{
            groupId: 'fdny-1', ts: 1_729_400_000,
            url: 'https://api.bcfy.io/audio/call.mp3',
            transcription: 'Engine 12 responding to 123 Main Street.',
            display: 'FDNY MN Dispatch'
          }],
          lastPos: 1_729_400_001
        }), {
          headers: { 'content-type': 'application/json' }
        });
      }
    );

    const calls = await provider.listCalls(new Date(0));

    assert.equal(new URL(requestedUrl).searchParams.get('playlist_uuid'), 'playlist-uuid');
    assert.equal(authorization.startsWith('Bearer '), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.borough, 'Manhattan');
    assert.equal(calls[0]?.audioUrl, 'https://api.bcfy.io/audio/call.mp3');
    assert.equal(calls[0]?.transcript, 'Engine 12 responding to 123 Main Street.');
    assert.equal(calls[0]?.groupName, 'FDNY MN Dispatch');
    assert.equal(calls[0]?.sourcePosition, 1_729_400_001);
    const status = provider.getFeedStatuses()[0];
    assert.equal(status?.state, 'online');
    assert.equal(status?.callsSeen, 1);
    assert.ok(status?.lastActivityAt);
  });

  it('reports a feed offline with a concise error after an API failure', async () => {
    const provider = new BroadcastifyApiProvider(
      'https://api.bcfy.io', 'key-id', 'issuer-id', 'test-secret',
      [{ playlistUuid: 'playlist-uuid', borough: 'Manhattan', agency: 'FDNY' }],
      async () => new Response('unavailable', { status: 503, statusText: 'Service Unavailable' })
    );
    await assert.rejects(provider.listCalls(new Date(0)), /503/);
    const status = provider.getFeedStatuses()[0];
    assert.equal(status?.state, 'offline');
    assert.match(status?.lastError ?? '', /503/);
  });
});

describe('createBroadcastifyJwt', () => {
  it('creates a short-lived JWT with documented claims and an HS256 signature', () => {
    const issuedAt = 1_699_693_200;
    const secret = 'test-api-key';
    const token = createBroadcastifyJwt('key-id', 'application-id', secret, issuedAt);
    const [header, payload, signature] = token.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header!, 'base64url').toString()), { alg: 'HS256', typ: 'JWT', kid: 'key-id' });
    assert.deepEqual(JSON.parse(Buffer.from(payload!, 'base64url').toString()), {
      iss: 'application-id',
      iat: issuedAt,
      exp: issuedAt + 3600
    });
    const expectedSignature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    assert.equal(signature, expectedSignature);
  });
});
