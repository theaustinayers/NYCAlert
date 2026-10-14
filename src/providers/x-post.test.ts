import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatXIncidentPost, XApiIncidentPublisher, type XIncidentPost } from './x-post.js';

const incident: XIncidentPost = {
  id: 'incident-123',
  headline: 'Reported Building Fire',
  incidentType: 'fire',
  agency: 'FDNY',
  borough: 'Manhattan',
  location: '3961 10th Avenue between West 207th Street and West 215th Street',
  unitIds: ['ENGINE 84', 'LADDER 34'],
  boxNumbers: ['BOX 1810'],
  newsworthinessScore: 5
};

describe('formatXIncidentPost', () => {
  it('formats incident details and hashtags without a URL to avoid the higher X URL-post rate', () => {
    const text = formatXIncidentPost(incident);
    assert.ok(text);
    assert.match(text, /FIRE · Reported Building Fire · FDNY/);
    assert.match(text, /Address: 3961 10th Avenue between West 207th Street and West 215th Street/);
    assert.match(text, /Manhattan/);
    assert.match(text, /ENGINE 84, LADDER 34/);
    assert.match(text, /BOX 1810/);
    assert.match(text, /#FDNY #Manhattan #NYC #Breaking #NYCAlert/);
    assert.doesNotMatch(text, /https?:\/\//);
  });

  it('uses the agency/borough tags and omits the breaking tag below public 5/5', () => {
    const text = formatXIncidentPost({ ...incident, agency: 'NYPD', borough: 'Staten Island', newsworthinessScore: 4, unitIds: [], boxNumbers: [] });
    assert.ok(text);
    assert.match(text, /#NYPD #StatenIsland #NYC #NYCAlert/);
    assert.doesNotMatch(text, /#Breaking/);
    assert.doesNotMatch(text, /Units:|Box:/);
  });

  it('does not silently truncate important fields when the post exceeds the X limit', () => {
    const text = formatXIncidentPost({ ...incident, headline: 'A'.repeat(280), location: 'B'.repeat(280) });
    assert.equal(text, undefined);
  });
});

describe('XApiIncidentPublisher', () => {
  it('uses the documented X create-post endpoint and returns the created post URL', async () => {
    let requestUrl = '';
    let authorization = '';
    let requestBody = '';
    const publisher = new XApiIncidentPublisher({ kind: 'oauth2-user', userAccessToken: 'unit-test-token' }, async (input, init) => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      requestBody = String(init?.body);
      return new Response(JSON.stringify({ data: { id: '123456789012345678' } }), { status: 201 });
    });

    const result = await publisher.publishIncident(incident);

    assert.equal(requestUrl, 'https://api.x.com/2/tweets');
    assert.equal(authorization, 'Bearer unit-test-token');
    assert.equal(JSON.parse(requestBody).text, result.text);
    assert.equal(result.postId, '123456789012345678');
    assert.equal(result.url, 'https://x.com/i/web/status/123456789012345678');
  });

  it('surfaces a bounded API error without echoing the access token', async () => {
    const publisher = new XApiIncidentPublisher({ kind: 'oauth2-user', userAccessToken: 'never-echo-this-secret' }, async () =>
      new Response(JSON.stringify({ title: 'Forbidden', detail: 'Posting is not permitted.' }), { status: 403 })
    );

    await assert.rejects(publisher.publishIncident(incident), (error: Error) => {
      assert.match(error.message, /Posting is not permitted/);
      assert.equal(error.message.includes('never-echo-this-secret'), false);
      return true;
    });
  });

  it('signs create-post requests with OAuth 1.0a user credentials', async () => {
    let authorization = '';
    let requestBody = '';
    const publisher = new XApiIncidentPublisher({
      kind: 'oauth1-user',
      consumerKey: 'consumer-key',
      consumerSecret: 'consumer-secret',
      accessToken: 'user-token',
      accessTokenSecret: 'user-secret'
    }, async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      requestBody = String(init?.body);
      return new Response(JSON.stringify({ data: { id: '987654321' } }), { status: 201 });
    });

    await publisher.publishIncident(incident);

    assert.match(authorization, /^OAuth /);
    assert.match(authorization, /oauth_consumer_key="consumer-key"/);
    assert.match(authorization, /oauth_token="user-token"/);
    assert.match(authorization, /oauth_signature_method="HMAC-SHA1"/);
    assert.match(authorization, /oauth_signature="[^"]+"/);
    assert.equal(requestBody.includes('consumer-secret'), false);
    assert.equal(requestBody.includes('user-secret'), false);
  });
});
