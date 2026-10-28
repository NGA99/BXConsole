import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskKey } from '../src/panels/sessions/agent-key';

/** Mirrors the module's own `ENDS`; changing one should fail against the other. */
const ENDS = 4;

test('a key keeps four characters at each end, and nothing in between', () => {
  // The shape every key this relay mints has.
  assert.equal(maskKey('4fa2bcc34b334dd941a5af4cc1d89583'), '4fa2…9583');
});

test('the middle of the key does not survive masking', () => {
  const key = 'aaaabbbbccccddddeeeeffff00001111';
  assert.ok(!maskKey(key).includes(key.slice(ENDS, -ENDS)));
});

test('two keys differing only in the middle do not mask to the same thing', () => {
  assert.notEqual(maskKey('15dbe7dbf30bbe7d9bbd716442f168ec'), maskKey('a77e2e00505d6dbdf82d459751b7e255'));
});

test('a key too short to hint at is not hinted at', () => {
  // Four either side of a twelve-character key is two thirds of the key.
  assert.equal(maskKey('abcd1234efgh'), '············');
});

test('no key is no dots', () => {
  assert.equal(maskKey(''), '');
});
