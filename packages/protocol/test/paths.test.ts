/**
 * Where each event is filed, and what may be used as a session id.
 *
 * A recording is read back by merging four files in seq order, each one
 * feeding a panel. An event filed in the wrong one does not error — it simply
 * never appears in the tab that should show it, and the panel looks empty for
 * a run that was busy. An event filed nowhere is dropped outright.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_MAX_MESSAGE_BYTES,
  BLOB_MAX_BYTES,
  BODY_INLINE_MAX_BYTES,
  PRE_PAYLOAD_MAX_BYTES,
  SESSION_FILES,
  fileForEventType,
  isValidSessionId,
  sessionDirName,
} from '../src/paths';

describe('which file an event belongs in', () => {
  const cases: Array<[string, keyof typeof SESSION_FILES]> = [
    ['console.message', 'console'],
    ['console.group', 'console'],
    ['console.clear', 'console'],
    ['error.uncaught', 'console'],
    ['error.unhandledrejection', 'console'],
    ['network.request', 'network'],
    ['network.response', 'network'],
    ['network.resource', 'network'],
    ['network.wsFrame', 'network'],
    ['page.navigated', 'page'],
    ['page.title', 'page'],
    ['interaction.click', 'history'],
    ['perf.lcp', 'history'],
    ['mark.custom', 'history'],
    ['dom.activity', 'history'],
  ];
  for (const [type, file] of cases) {
    test(`${type} → ${file}.ndjson`, () => assert.equal(fileForEventType(type), file));
  }

  test('errors are filed with the console, because that is the tab that shows them', () => {
    assert.equal(fileForEventType('error.uncaught'), fileForEventType('console.message'));
  });

  test('dom.activity is History’s, even though every other dom.* is not an event at all', () => {
    // `dom.getStyles` and friends are commands, not recorded events; only the
    // activity signal is filed, and only to History.
    assert.equal(fileForEventType('dom.activity'), 'history');
    assert.equal(fileForEventType('dom.getStyles'), null);
    assert.equal(fileForEventType('dom.setAttribute'), null);
  });

  test('a screen event is not filed here: the recording has its own log', () => {
    for (const t of ['screen.snapshot', 'screen.mutations', 'screen.cursor', 'screen.stopped']) {
      assert.equal(fileForEventType(t), null, t);
    }
  });

  test('replies and commands are not events and are filed nowhere', () => {
    for (const t of ['eval.result', 'object.properties', 'sources.text', 'asset.data', 'session.hello', 'session.ack']) {
      assert.equal(fileForEventType(t), null, t);
    }
  });

  test('an unknown type is dropped rather than guessed at', () => {
    assert.equal(fileForEventType(''), null);
    assert.equal(fileForEventType('whatever.new'), null);
    assert.equal(fileForEventType('networkish.request'), null, 'the prefix has to be the whole first segment');
  });

  test('every file an event can be filed in is one the reader merges', () => {
    const filed = new Set(cases.map(([, f]) => f));
    assert.deepEqual([...filed].sort(), ['console', 'history', 'network', 'page']);
    for (const f of filed) assert.match(SESSION_FILES[f], /\.ndjson$/);
  });
});

describe('what may be a session id', () => {
  test('the ordinary ones are allowed', () => {
    for (const id of ['abc123', 'a', 'A-Z_0-9', 'x'.repeat(64), '213d44e06425']) {
      assert.equal(isValidSessionId(id), true, id);
    }
  });

  test('anything that could shape a path is refused', () => {
    // The id comes from the page, and it ends up in a directory the relay
    // writes to and, on forget, removes recursively.
    for (const id of ['', '.', '..', '../etc', 'a/b', 'a\\b', 'x'.repeat(65), 'has space', 'nul\0byte', 'a.b', '~root', '%2e%2e']) {
      assert.equal(isValidSessionId(id), false, JSON.stringify(id));
    }
  });

  test('a refused id throws rather than quietly naming some other directory', () => {
    assert.throws(() => sessionDirName('../escape'));
    assert.equal(sessionDirName('abc123'), 'session-abc123');
  });
});

describe('the ceilings have to stay in the right order', () => {
  /*
   * These numbers only work as a set. The socket limit is the outermost one:
   * past it `ws` closes the connection, so an agent that can legitimately
   * produce a larger message would have its run killed rather than recorded.
   * Nothing here is a tuning preference — each is a bound on what an honest
   * agent can send, and raising one without the other breaks real runs.
   */
  test('a message may carry anything the agent can legitimately produce', () => {
    assert.ok(
      AGENT_MAX_MESSAGE_BYTES > BLOB_MAX_BYTES,
      'a body the store would accept must fit through the socket that delivers it',
    );
    assert.ok(
      AGENT_MAX_MESSAGE_BYTES > PRE_PAYLOAD_MAX_BYTES,
      'the pre-payload travels the other way, but a run that echoes it must still fit',
    );
    // Headroom, not a hair's breadth: a message is a body plus its event, and
    // a DOM keyframe of a heavy page has been measured at about 200 kB.
    assert.ok(AGENT_MAX_MESSAGE_BYTES >= BLOB_MAX_BYTES * 2, 'too little room between the body limit and the message limit');
  });

  test('a body is stored before it is large, and inline while it is small', () => {
    assert.ok(BODY_INLINE_MAX_BYTES < BLOB_MAX_BYTES, 'nothing would ever reach the store');
    assert.ok(BODY_INLINE_MAX_BYTES > 0);
  });

  test('the socket limit is far below the library default it replaces', () => {
    // `ws` defaults to 100 MB, which on a socket that cannot ask for a
    // password is not a limit at all.
    assert.ok(AGENT_MAX_MESSAGE_BYTES < 100 * 1024 * 1024 / 4, 'the cap is not buying much over the default');
  });
});
