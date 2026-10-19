/**
 * Handles requests that arrive from the console (via the relay) and replies.
 *
 *   eval.request          -> eval.result   (console input box)
 *   object.getProperties  -> object.properties (expanding a logged object)
 *   screen.start / stop   -> screen.snapshot + screen.mutations stream (Screen tab)
 *   screen.keyframe       -> screen.snapshot (keyframe: true) for the recording
 */
import type { ServerToAgent } from '@bxconsole/protocol';
import { serialize, propertiesOf, objectById } from './serialize';
import { startScreen, stopScreen, keyframeScreen, handleScreenInput, screenIdOf, nodeByScreenId } from './hooks/screen';
import { configureNetwork } from './hooks/network';
import { domSetAttribute, domSetText, domRemoveNode, domScrollIntoView, domStyles } from './hooks/dom';
import { listSources, getSource } from './hooks/sources';
import { getAsset } from './hooks/assets';
import type { Transport } from './transport';

export function createCommandHandler(transport: Transport) {
  return (msg: ServerToAgent): void => {
    switch (msg.type) {
      case 'eval.request': {
        const start = performance.now();
        // Like DevTools, `$0` is the element selected in the Elements tab while the expression runs.
        const g = globalThis as Record<string, unknown>;
        const had$0 = '$0' in g;
        const prev$0 = g.$0;
        const sel = msg.context?.selectedNodeId;
        if (sel !== undefined) g.$0 = nodeByScreenId(sel) ?? undefined;
        const restore = () => {
          if (sel === undefined) return;
          if (had$0) g.$0 = prev$0;
          else delete g.$0;
        };
        try {
          // Indirect eval so the expression runs in global scope, like DevTools.
          const result = (0, eval)(msg.expression) as unknown;
          restore();
          transport.send({
            type: 'eval.result',
            commandId: msg.commandId,
            result: serialize(result),
            durationMs: performance.now() - start,
          });
        } catch (err) {
          restore();
          transport.send({
            type: 'eval.result',
            commandId: msg.commandId,
            exception: serialize(err),
            durationMs: performance.now() - start,
          });
        }
        return;
      }
      case 'dom.storeGlobal': {
        const node = nodeByScreenId(msg.id);
        let name: string | null = null;
        if (node) {
          name = `temp${nextTemp++}`;
          (globalThis as Record<string, unknown>)[name] = node;
        }
        transport.send({ type: 'object.stored', requestId: msg.requestId, name });
        return;
      }
      case 'object.getProperties': {
        transport.send({
          type: 'object.properties',
          requestId: msg.requestId,
          objectId: msg.objectId,
          properties: propertiesOf(msg.objectId),
        });
        return;
      }
      case 'object.invokeGetter': {
        const obj = objectById(msg.objectId);
        let value: unknown;
        try {
          value = obj ? (obj as Record<string, unknown>)[msg.name] : undefined;
        } catch (err) {
          value = err;
        }
        transport.send({ type: 'object.property', requestId: msg.requestId, objectId: msg.objectId, name: msg.name, value: serialize(value) });
        return;
      }
      case 'object.storeGlobal': {
        const obj = objectById(msg.objectId);
        let name: string | null = null;
        if (obj) {
          name = `temp${nextTemp++}`;
          (globalThis as Record<string, unknown>)[name] = obj;
        }
        transport.send({ type: 'object.stored', requestId: msg.requestId, name });
        return;
      }
      case 'object.toJSON': {
        const obj = objectById(msg.objectId);
        let text: string | null = null;
        try {
          text = obj ? JSON.stringify(obj, null, 2) ?? null : null;
        } catch {
          text = null;
        }
        transport.send({ type: 'object.json', requestId: msg.requestId, text });
        return;
      }
      case 'node.locate': {
        const obj = objectById(msg.objectId);
        const screenId = obj instanceof Node ? screenIdOf(obj) ?? null : null;
        transport.send({ type: 'node.located', requestId: msg.requestId, screenId });
        return;
      }
      case 'node.scrollIntoView': {
        const obj = objectById(msg.objectId);
        if (obj instanceof Element) obj.scrollIntoView({ block: 'center', inline: 'nearest' });
        return;
      }
      case 'completions.request': {
        transport.send({ type: 'completions.result', requestId: msg.requestId, names: completions(msg.expression) });
        return;
      }
      case 'network.configure':
        configureNetwork(msg);
        return;
      case 'dom.setAttribute':
        domSetAttribute(msg.id, msg.name, msg.value);
        return;
      case 'dom.setText':
        domSetText(msg.id, msg.text);
        return;
      case 'dom.removeNode':
        domRemoveNode(msg.id);
        return;
      case 'dom.scrollIntoView':
        domScrollIntoView(msg.id);
        return;
      case 'sources.list':
        transport.send({ type: 'sources.list', requestId: msg.requestId, sources: listSources() });
        return;
      case 'sources.get':
        void getSource(msg.url).then((source) => transport.send({ type: 'sources.text', requestId: msg.requestId, source }));
        return;
      case 'asset.get':
        void getAsset(msg.url).then((asset) => transport.send({ type: 'asset.data', requestId: msg.requestId, asset }));
        return;
      case 'dom.getStyles': {
        let styles = null;
        try {
          styles = domStyles(msg.id);
        } catch {
          styles = null;
        }
        transport.send({ type: 'dom.styles', requestId: msg.requestId, id: msg.id, styles });
        return;
      }
      case 'screen.start':
        startScreen(transport);
        return;
      case 'screen.keyframe':
        keyframeScreen();
        return;
      case 'screen.stop':
        stopScreen();
        return;
      case 'screen.input':
        handleScreenInput(msg.input);
        return;
      case 'session.ack':
        return;
    }
  };
}

let nextTemp = 1;
const MAX_COMPLETIONS = 500;
const IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * Property names of the value of `expression`, own properties first, then up
 * the prototype chain. Empty expression = global scope. The expression is
 * evaluated, so the prompt only asks for member chains without calls.
 */
function completions(expression: string): string[] {
  let target: unknown;
  try {
    target = expression ? (0, eval)(expression) : globalThis;
  } catch {
    return [];
  }
  if (target === null || target === undefined) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (let o: object | null = Object(target); o; o = Object.getPrototypeOf(o)) {
    let names: string[];
    try {
      names = Object.getOwnPropertyNames(o);
    } catch {
      break;
    }
    const level = names.filter((n) => IDENT.test(n) && !seen.has(n)).sort();
    for (const n of level) {
      seen.add(n);
      out.push(n);
      if (out.length >= MAX_COMPLETIONS) return out;
    }
  }
  return out;
}
