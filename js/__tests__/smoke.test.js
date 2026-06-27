/**
 * Smoke test — confirms the lightweight test harness is wired up correctly.
 *
 * Verifies that:
 *   1. The vitest runner executes a one-shot run (no watch).
 *   2. fast-check is installed and can drive a property check.
 *
 * This file intentionally tests nothing about the application itself; it only
 * proves the tooling (vitest + fast-check) works before real adapter tests
 * are added in task 2.2+.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

describe('test harness smoke', () => {
  it('runs a trivial vitest assertion', () => {
    expect(1 + 1).toBe(2);
  });

  it('runs a fast-check property (addition is commutative)', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
      { numRuns: 100 }
    );
  });
});
