/**
 * Shared test helpers for admission limiter stubs.
 * Extracted here so that embedding/retrieval/model tests can import a no-op
 * limiter without importing admission.test.ts (which would re-execute tests).
 */
import type { AdmissionLimiter } from "../src/model-admission.js";

/** A limiter that always grants immediately and releases silently. */
export function noopLimiter(): AdmissionLimiter {
  return {
    acquire: async () => ({ release: async () => undefined }),
    close: async () => undefined,
  };
}

/**
 * A limiter that always rejects with the given AdmissionError.
 * Import AdmissionError from the index to avoid a direct dep on admission.ts internals.
 */
export function denyingLimiter(error: Error): AdmissionLimiter {
  return {
    acquire: async () => { throw error; },
    close: async () => undefined,
  };
}
