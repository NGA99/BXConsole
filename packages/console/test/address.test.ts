import { test } from 'node:test';
import assert from 'node:assert/strict';
import { address } from '../src/app/address';

test('https says nothing, so its scheme is dropped', () => {
  assert.deepEqual(address('https://example.com/orders'), { head: 'example.com', tail: '/orders' });
});

test('plain http is kept, because it is a fact about the engagement', () => {
  assert.deepEqual(address('http://localhost:7331/demo/payload.html'), {
    head: 'http://localhost:7331',
    tail: '/demo/payload.html',
  });
});

test('a bare slash is dropped', () => {
  assert.deepEqual(address('https://example.com/'), { head: 'example.com', tail: '' });
});

test('a bare slash is kept once a query hangs off it', () => {
  // Three windows on /?1, /?2 and /?3 are told apart by nothing else.
  assert.deepEqual(address('https://example.com/?2'), { head: 'example.com', tail: '/?2' });
});

test('the query and the fragment travel with the path', () => {
  assert.deepEqual(address('https://example.com/search?q=a%20b#hit'), {
    head: 'example.com',
    tail: '/search?q=a%20b#hit',
  });
});

test('a URL with no host is shown whole, not split into an invented authority', () => {
  assert.deepEqual(address('about:blank'), { head: 'about:blank', tail: '' });
});

test('what the browser cannot parse at all is shown whole', () => {
  assert.deepEqual(address('javascript:alert(1)'), { head: 'javascript:alert(1)', tail: '' });
});

test('a string that is not a URL comes back untouched', () => {
  assert.deepEqual(address('(unknown)'), { head: '(unknown)', tail: '' });
});
