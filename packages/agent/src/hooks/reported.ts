/**
 * URLs a request hook has already described, whose Resource Timing entry the
 * browser files under `other`.
 *
 * Its own module, and a very small one, because both sides of the question
 * need it: network.ts records into it as it hooks a stream, and resources.ts
 * reads it when deciding what to skip. Keeping it in network.ts made that an
 * import of a module whose first act is to take a reference to `window.fetch`,
 * which is fine in a page and fatal in a test.
 */
export const hookedOtherUrls = new Set<string>();
