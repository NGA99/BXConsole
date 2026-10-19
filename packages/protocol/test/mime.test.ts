/**
 * The one rule both sides use to decide whether a body is text.
 *
 * This replaced three regexes — one in the agent's source reader, one in its
 * network hook, one in the console's body view — that each knew about a
 * different handful of types. Where they disagreed, a body went out encoded
 * one way and came back read the other, and the damage showed up as a corrupt
 * file rather than as an error.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isTextualMime, mimeType } from '../src/mime';

describe('reading a content type', () => {
  test('parameters and case are not part of the type', () => {
    assert.equal(mimeType('Application/JSON; charset=utf-8'), 'application/json');
    assert.equal(mimeType('  text/html  '), 'text/html');
    assert.equal(mimeType(''), '');
  });
});

describe('what counts as text', () => {
  for (const m of [
    'text/plain',
    'text/html',
    'text/css',
    'text/csv',
    'application/json',
    'application/xml',
    'application/javascript',
    'application/ecmascript',
    'application/x-javascript',
    'application/x-www-form-urlencoded',
    'application/ld+json',
    'application/vnd.api+json',
    'image/svg+xml',
    'application/json; charset=utf-8',
  ]) {
    test(`${m} is text`, () => assert.equal(isTextualMime(m), true));
  }

  for (const m of ['image/png', 'image/jpeg', 'font/woff2', 'application/octet-stream', 'video/mp4', 'application/pdf', 'application/wasm']) {
    test(`${m} is not text`, () => assert.equal(isTextualMime(m), false));
  }

  test('an svg is markup, not a picture — it is the one image you read', () => {
    assert.equal(isTextualMime('image/svg+xml'), true);
    assert.equal(isTextualMime('image/svg'), false, 'only the real type, not a prefix match');
  });

  test('a +json or +xml suffix counts, wherever it appears', () => {
    assert.equal(isTextualMime('application/problem+json'), true);
    assert.equal(isTextualMime('application/atom+xml'), true);
    assert.equal(isTextualMime('application/jsonsomething'), false, 'the suffix must end the type');
  });

  test('an unlabelled body is not text here, so the agent never decodes bytes as a string', () => {
    // A caller that would rather guess text says so at its own call site,
    // which keeps the guess somewhere a reader can find it.
    assert.equal(isTextualMime(''), false);
    assert.equal(isTextualMime('   '), false);
    assert.equal(isTextualMime('; charset=utf-8'), false);
  });

  test('a type that merely contains "json" is not json', () => {
    assert.equal(isTextualMime('application/x-json-rpc-binary'), false);
    assert.equal(isTextualMime('image/json-sprite'), false);
  });
});
