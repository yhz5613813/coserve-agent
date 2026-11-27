// Browser code calls the `studioSha256` global that index.html and the STEP worker load from public/sha256.js; tests load the same script.
export {};
if (typeof self === 'undefined') Object.assign(globalThis, { self: globalThis });
// The script is a browser IIFE without type declarations; it only needs to run after `self` exists.
const script = '../public/sha256.js';
await import(script);
