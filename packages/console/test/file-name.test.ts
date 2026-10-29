import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileName } from '../src/devtools-ui/file-name';

test('the last segment of the path, which is what the file is called', () => {
  assert.equal(fileName('https://app.test/static/js/main.9f2a.js'), 'main.9f2a.js');
  assert.equal(fileName('https://app.test/a.css'), 'a.css');
});

test('a trailing slash is not a segment', () => {
  assert.equal(fileName('https://app.test/admin/'), 'admin');
});

test('the root serves an index, and is named one rather than left blank', () => {
  assert.equal(fileName('https://app.test/'), '(index)');
  assert.equal(fileName('https://app.test'), '(index)');
});

test('the query is not part of the name', () => {
  // The Network list's own Name column keeps it, deliberately; this does not.
  assert.equal(fileName('https://app.test/search?q=m5+ultra&hl=ko'), 'search');
  assert.equal(fileName('https://app.test/a.js#L40'), 'a.js');
});

test('something that is not a URL is its own best name', () => {
  assert.equal(fileName('<anonymous>'), '<anonymous>');
  assert.equal(fileName(''), '');
});
