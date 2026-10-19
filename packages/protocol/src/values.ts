/**
 * Serialized runtime values.
 *
 * The agent cannot ship live JS objects over the wire, so every value that
 * crosses to the console is reduced to this shape. It mirrors the role of
 * CDP's `Runtime.RemoteObject`: a shallow preview plus an optional `id` the
 * console can use to lazily ask the agent for more (`object.getProperties`).
 */

export type ObjectId = string;

export type SerializedValue =
  | { t: 'undefined' }
  | { t: 'null' }
  | { t: 'boolean'; v: boolean }
  | { t: 'number'; v: number | 'NaN' | 'Infinity' | '-Infinity' | '-0' }
  | { t: 'bigint'; v: string }
  | { t: 'string'; v: string; truncated?: boolean }
  | { t: 'symbol'; v: string }
  | { t: 'function'; name: string; src?: string; id?: ObjectId }
  | { t: 'date'; v: string }
  | { t: 'regexp'; v: string }
  | { t: 'error'; name: string; message: string; stack?: string; cause?: SerializedValue; id?: ObjectId }
  | {
      t: 'node';
      nodeType: number;
      nodeName: string;
      attrs?: Record<string, string>;
      preview: string;
      id?: ObjectId;
    }
  | { t: 'array'; length: number; preview: SerializedValue[]; truncated?: boolean; id?: ObjectId }
  | {
      t: 'object';
      className: string;
      preview: PropertyPreview[];
      truncated?: boolean;
      id?: ObjectId;
    }
  | { t: 'map'; size: number; preview: Array<[SerializedValue, SerializedValue]>; id?: ObjectId }
  | { t: 'set'; size: number; preview: SerializedValue[]; id?: ObjectId }
  | { t: 'promise'; id?: ObjectId }
  | { t: 'circular'; path: string }
  /** an accessor shown without being called; expanding the row invokes it */
  | { t: 'getter' }
  | { t: 'unserializable'; description: string };

export interface PropertyPreview {
  name: string;
  value: SerializedValue;
  enumerable?: boolean;
  /** true when the property is a getter that was not evaluated */
  getter?: boolean;
}
