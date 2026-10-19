/**
 * Everything the Console tab shows passes through here.
 *
 * Being wrong in this file does not look like a bug in bxconsole — it looks
 * like a bug in the page being debugged, which is the worst way to be wrong.
 * The rule that matters most is the quiet one: reading a value must not run
 * the page's own code. Logging an object that has a getter should not fire
 * that getter, or merely watching a page changes it.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { objectById, propertiesOf, serialize } from '../src/serialize';

/** Narrow a SerializedValue to the shape a test is asking about. */
const as = <T,>(v: unknown) => v as T;

describe('primitives', () => {
  test('each type is tagged as itself', () => {
    assert.deepEqual(serialize(undefined), { t: 'undefined' });
    assert.deepEqual(serialize(null), { t: 'null' });
    assert.deepEqual(serialize(true), { t: 'boolean', v: true });
    assert.deepEqual(serialize(42), { t: 'number', v: 42 });
    assert.deepEqual(serialize(7n), { t: 'bigint', v: '7' });
    assert.deepEqual(serialize('hi'), { t: 'string', v: 'hi' });
  });

  test('the numbers JSON cannot carry survive as words', () => {
    // JSON.stringify turns all of these into null, so the console would show
    // nothing where the page said NaN.
    assert.equal(as<{ v: unknown }>(serialize(NaN)).v, 'NaN');
    assert.equal(as<{ v: unknown }>(serialize(Infinity)).v, 'Infinity');
    assert.equal(as<{ v: unknown }>(serialize(-Infinity)).v, '-Infinity');
    assert.equal(as<{ v: unknown }>(serialize(-0)).v, '-0', 'negative zero is a real distinction in a debugger');
    assert.equal(as<{ v: unknown }>(serialize(0)).v, 0);
  });

  test('a symbol keeps its description', () => {
    assert.deepEqual(serialize(Symbol('tag')), { t: 'symbol', v: 'Symbol(tag)' });
  });

  test('a function keeps its name, and an anonymous one says so by being empty', () => {
    const named = as<{ t: string; name: string; id: string }>(serialize(function greet() {}));
    assert.equal(named.t, 'function');
    assert.equal(named.name, 'greet');
    assert.ok(named.id, 'a function is expandable, so it needs an id');
    assert.equal(as<{ name: string }>(serialize(Object.defineProperty(() => {}, 'name', { value: '' }))).name, '');
  });

  test('a very long string is cut and says that it was', () => {
    const under = 'x'.repeat(10_000);
    assert.equal(as<{ truncated?: boolean }>(serialize(under)).truncated, undefined, 'exactly at the limit is not over it');
    const over = as<{ v: string; truncated: boolean }>(serialize('x'.repeat(10_001)));
    assert.equal(over.v.length, 10_000);
    assert.equal(over.truncated, true);
  });
});

describe('not running the page’s code', () => {
  test('a getter is reported, not invoked', () => {
    let fired = 0;
    const obj = {
      plain: 1,
      get expensive() {
        fired++;
        return 'computed';
      },
    };
    const out = as<{ preview: Array<{ name: string; value: { t: string } }> }>(serialize(obj));
    assert.equal(fired, 0, 'logging an object must not run its getters');
    const got = out.preview.find((p) => p.name === 'expensive');
    assert.equal(got?.value.t, 'getter');
  });

  test('a getter that throws does not take the whole value with it', () => {
    const obj = {
      ok: 1,
      get boom(): never {
        throw new Error('side effect');
      },
    };
    const out = as<{ preview: Array<{ name: string }> }>(serialize(obj));
    assert.deepEqual(out.preview.map((p) => p.name).sort(), ['boom', 'ok']);
  });

  test('an object whose keys cannot be listed is still shown as something', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('no');
        },
      },
    );
    const out = as<{ t: string; preview: unknown[] }>(serialize(hostile));
    assert.equal(out.t, 'object');
    assert.deepEqual(out.preview, []);
  });
});

describe('references back into the value', () => {
  test('a cycle is named rather than followed', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = as<{ preview: Array<{ name: string; value: { t: string; path?: string } }> }>(serialize(a));
    const self = out.preview.find((p) => p.name === 'self');
    assert.equal(self?.value.t, 'circular');
    assert.equal(self?.value.path, '$', 'the path says where the cycle points back to');
  });

  test('a cycle through an array keeps the index in its path', () => {
    const arr: unknown[] = [];
    arr.push({ back: arr });
    const out = as<{ preview: Array<{ preview: Array<{ name: string; value: { path?: string } }> }> }>(serialize(arr));
    assert.equal(out.preview[0]!.preview[0]!.value.path, '$');
  });

  test('a cycle back to an inner object names that object, not the root', () => {
    const inner: Record<string, unknown> = { n: 1 };
    inner.back = inner;
    const out = as<{ preview: Array<{ name: string; value: { preview: Array<{ name: string; value: { t: string; path?: string } }> } }> }>(
      serialize({ b: inner }),
    );
    const back = out.preview[0]!.value.preview.find((p) => p.name === 'back');
    assert.equal(back?.value.t, 'circular');
    assert.equal(back?.value.path, '$.b', 'it points at the object it points at');
  });

  test('the same object twice side by side is not a cycle', () => {
    // A shared reference is ordinary; reporting it as circular would hide
    // half of what the page logged.
    const shared = { n: 1 };
    const out = as<{ preview: Array<{ t: string }> }>(serialize([shared, shared]));
    assert.deepEqual(out.preview.map((p) => p.t), ['object', 'object']);
  });
});

describe('collections', () => {
  test('an array reports its real length and previews the front of it', () => {
    const out = as<{ t: string; length: number; preview: unknown[]; truncated: boolean }>(serialize(Array.from({ length: 250 }, (_, i) => i)));
    assert.equal(out.t, 'array');
    assert.equal(out.length, 250, 'the length is the array’s, not the preview’s');
    assert.equal(out.preview.length, 100);
    assert.equal(out.truncated, true);
  });

  test('a short array is not marked truncated', () => {
    assert.equal(as<{ truncated: boolean }>(serialize([1, 2, 3])).truncated, false);
  });

  test('a Map keeps its size and previews pairs', () => {
    const m = new Map<string, number>(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const out = as<{ t: string; size: number; preview: unknown[] }>(serialize(m));
    assert.equal(out.t, 'map');
    assert.equal(out.size, 30);
    assert.equal(out.preview.length, 10);
    assert.deepEqual(as<[{ v: string }, { v: number }]>(out.preview[0]).map((x) => x.v), ['k0', 0]);
  });

  test('a Set keeps its size and previews items', () => {
    const out = as<{ t: string; size: number; preview: Array<{ v: number }> }>(serialize(new Set([1, 2, 3])));
    assert.equal(out.t, 'set');
    assert.equal(out.size, 3);
    assert.deepEqual(out.preview.map((p) => p.v), [1, 2, 3]);
  });

  test('a typed array is not enumerated index by index', () => {
    // Every index of a few megabytes would be walked to show ten of them,
    // which freezes the page that is being debugged.
    const big = new Uint8Array(5_000_000);
    const out = as<{ t: string; className: string; preview: unknown[]; truncated: boolean }>(serialize(big));
    assert.equal(out.className, 'Uint8Array');
    assert.equal(out.preview.length, 10);
    assert.equal(out.truncated, true);
  });

  test('a DataView is an ordinary object, not an indexed one', () => {
    assert.equal(as<{ className: string }>(serialize(new DataView(new ArrayBuffer(8)))).className, 'DataView');
  });
});

describe('how deep it goes', () => {
  test('past two levels it ships the shape and leaves the contents to an expand', () => {
    const deep = { a: { b: { c: { d: 1 } } } };
    const l0 = as<{ preview: Array<{ value: { preview: Array<{ value: { preview: unknown[]; truncated: boolean } }> } }> }>(serialize(deep));
    const l2 = l0.preview[0]!.value.preview[0]!.value;
    assert.deepEqual(l2.preview, [], 'the third level is a stub');
    assert.equal(l2.truncated, true);
  });

  test('a deep value still carries an id, so the console can go and get it', () => {
    const deep = { a: { b: { c: { d: 1 } } } };
    const l0 = as<{ preview: Array<{ value: { preview: Array<{ value: { id: string } }> } }> }>(serialize(deep));
    assert.ok(l0.preview[0]!.value.preview[0]!.value.id);
  });
});

describe('special objects', () => {
  test('an Error keeps its name, message and stack', () => {
    const out = as<{ t: string; name: string; message: string; stack?: string }>(serialize(new TypeError('bad thing')));
    assert.equal(out.t, 'error');
    assert.equal(out.name, 'TypeError');
    assert.equal(out.message, 'bad thing');
    assert.match(String(out.stack), /TypeError/);
  });

  test('an Error’s cause is serialized too', () => {
    const out = as<{ cause?: { t: string; message?: string } }>(serialize(new Error('outer', { cause: new Error('inner') })));
    assert.equal(out.cause?.t, 'error');
    assert.equal(out.cause?.message, 'inner');
  });

  test('a Date and a RegExp read as a person wrote them', () => {
    assert.equal(as<{ t: string }>(serialize(new Date(0))).t, 'date');
    assert.deepEqual(serialize(/ab+c/gi), { t: 'regexp', v: '/ab+c/gi' });
  });

  test('a Promise is not awaited', () => {
    const never = new Promise(() => {});
    const out = as<{ t: string; id: string }>(serialize(never));
    assert.equal(out.t, 'promise');
    assert.ok(out.id);
  });

  test('a class instance is named by its class', () => {
    class Order {
      constructor(public id = 1) {}
    }
    assert.equal(as<{ className: string }>(serialize(new Order())).className, 'Order');
    assert.equal(as<{ className: string }>(serialize(Object.create(null))).className, 'Object', 'a null prototype has no class to name');
  });
});

describe('expanding later', () => {
  test('an id gets the same object back', () => {
    const obj = { a: 1 };
    const id = as<{ id: string }>(serialize(obj)).id;
    assert.equal(objectById(id), obj);
  });

  test('an unknown id is null rather than a throw', () => {
    assert.equal(propertiesOf('no-such-id'), null);
    assert.equal(objectById('no-such-id'), undefined);
  });

  test('properties include the non-enumerable and the prototype, as DevTools does', () => {
    const obj: Record<string, unknown> = { visible: 1 };
    Object.defineProperty(obj, 'hidden', { value: 2, enumerable: false });
    const id = as<{ id: string }>(serialize(obj)).id;
    const props = propertiesOf(id)!;
    const byName = Object.fromEntries(props.map((p) => [p.name, p]));
    assert.equal(byName.visible!.enumerable, true);
    assert.equal(byName.hidden!.enumerable, false);
    assert.ok(byName['[[Prototype]]'], 'the prototype row is how a reader walks up the chain');
  });

  test('a getter is still not invoked when the row is listed', () => {
    let fired = 0;
    const obj = {
      get later() {
        fired++;
        return 1;
      },
    };
    const id = as<{ id: string }>(serialize(obj)).id;
    const got = propertiesOf(id)!.find((p) => p.name === 'later');
    assert.equal(fired, 0);
    assert.equal(got?.getter, true);
  });

  test('a symbol-keyed property is listed under a readable name', () => {
    const obj = { [Symbol.for('tag')]: 1 };
    const id = as<{ id: string }>(serialize(obj)).id;
    assert.ok(propertiesOf(id)!.some((p) => p.name === 'Symbol(tag)'));
  });
});
