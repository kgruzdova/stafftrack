// Vite substitutes this module for cloudflare:workers only in the Pages build.
// The original Worker and its bindings are untouched.
export const env: { DB?: D1Database; BUCKET?: R2Bucket } = {};
