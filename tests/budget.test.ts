import { expect, test } from "vitest";
import { BudgetTracker } from "../src/budget/tracker.js";

const caps = { maxIterationsPerSprint: 6, negotiationRounds: 5, dollarCeiling: null as number | null, wallClockMsPerSprint: 1000 };
const thr = { advanceScore: 85, noProgressDelta: 5, noProgressWindow: 2 };

test("dollar ceiling does NOT trip when null (off)", () => {
  const b = new BudgetTracker(caps, thr, 0);
  b.recordCost(9999);
  expect(b.checkStops(0)).toBeNull();
});

test("dollar ceiling trips only when a ceiling is set", () => {
  const b = new BudgetTracker({ ...caps, dollarCeiling: 10 }, thr, 0);
  b.recordCost(11);
  expect(b.checkStops(0)).toBe("dollar-ceiling");
});

test("max iterations trips", () => {
  const b = new BudgetTracker(caps, thr, 0);
  for (let i = 0; i < 6; i++) b.recordIteration();
  expect(b.checkStops(0)).toBe("max-iteration");
});

test("wall clock trips on injected time", () => {
  const b = new BudgetTracker(caps, thr, 0);
  expect(b.checkStops(1001)).toBe("wall-clock");
});

test("wall clock is per-sprint: resetSprint rebaselines the clock", () => {
  const b = new BudgetTracker(caps, thr, 0);
  expect(b.checkStops(1001)).toBe("wall-clock"); // 1001ms since start of sprint
  b.resetSprint(1001);                           // new sprint starts at t=1001
  expect(b.checkStops(1500)).toBeNull();         // only 499ms into the new sprint
  expect(b.checkStops(2002)).toBe("wall-clock"); // 1001ms into the new sprint
});

test("no-progress: 2 consecutive sub-delta improvements", () => {
  const b = new BudgetTracker(caps, thr, 0);
  b.recordScore(80); expect(b.checkStops(0)).toBeNull();
  b.recordScore(82); expect(b.checkStops(0)).toBeNull(); // 1 flat
  b.recordScore(84); expect(b.checkStops(0)).toBe("no-progress"); // 2 flat
});

test("a big jump resets the flat counter", () => {
  const b = new BudgetTracker(caps, thr, 0);
  b.recordScore(50); b.recordScore(52); b.recordScore(90); b.recordScore(91);
  expect(b.checkStops(0)).toBeNull(); // only 1 flat since the reset
});

test("resetSprint clears the iteration counter", () => {
  const b = new BudgetTracker(caps, thr, 0);
  for (let i = 0; i < 6; i++) b.recordIteration();
  expect(b.checkStops(0)).toBe("max-iteration");
  b.resetSprint(0);
  expect(b.checkStops(0)).toBeNull();
});

test("resetSprint clears the no-progress flat counter", () => {
  const b = new BudgetTracker(caps, thr, 0);
  b.recordScore(80); b.recordScore(82); b.recordScore(84);
  expect(b.checkStops(0)).toBe("no-progress");
  b.resetSprint(0);
  b.recordScore(84); // fresh baseline after reset — no prior score to compare
  expect(b.checkStops(0)).toBeNull();
});

test("checkStops precedence: dollar-ceiling wins over max-iteration", () => {
  const b = new BudgetTracker({ ...caps, dollarCeiling: 10 }, thr, 0);
  b.recordCost(11);
  for (let i = 0; i < 6; i++) b.recordIteration();
  expect(b.checkStops(0)).toBe("dollar-ceiling");
});

test("spent getter returns accumulated cost", () => {
  const b = new BudgetTracker(caps, thr, 0);
  b.recordCost(4); b.recordCost(7);
  expect(b.spent).toBe(11);
});
