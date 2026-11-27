/** SHA-256 from public/sha256.js: native crypto.subtle when available, else a JS digest for plain-HTTP intranet pages. */
declare function studioSha256(data: ArrayBuffer | Uint8Array): Promise<ArrayBuffer>;
