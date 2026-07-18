import { expect, test } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSlug, runDate, buildRunDir, reserveRunDir, runBranch } from "../src/state/run-path.js";

test("projectSlug uses the project folder's basename, slugified", () => {
  expect(projectSlug("/Users/me/dev/CSV Tool/")).toBe("csv-tool");
  expect(projectSlug("/tmp/x")).toBe("x");
});

test("projectSlug falls back to 'project' for an empty/odd basename", () => {
  expect(projectSlug("/")).toBe("project");
});

test("runDate is UTC YYYY-MM-DD", () => {
  expect(runDate(0)).toBe("1970-01-01");
});

test("buildRunDir composes runs/<project>/<date>-<title>", () => {
  expect(buildRunDir("runs", "/tmp/csv-tool", "CSV JSON Converter", 0, []))
    .toBe("runs/csv-tool/1970-01-01-csv-json-converter");
});

test("buildRunDir suffixes -2, -3 on collision with existing siblings", () => {
  const sibs = ["1970-01-01-csv-json-converter", "1970-01-01-csv-json-converter-2"];
  expect(buildRunDir("runs", "/tmp/csv-tool", "CSV JSON Converter", 0, sibs))
    .toBe("runs/csv-tool/1970-01-01-csv-json-converter-3");
});

test("buildRunDir falls back to 'run' when the title slugifies to empty", () => {
  expect(buildRunDir("runs", "/tmp/csv-tool", "!!!", 0, []))
    .toBe("runs/csv-tool/1970-01-01-run");
});

test("runBranch composes the shared run-<runId> name", () => {
  expect(runBranch("Build a CSV converter", "abc")).toBe("run-abc");
});

test("reserveRunDir creates the dir and hands a second reservation a distinct path", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "runs-"));
  const a = reserveRunDir(runsDir, "/tmp/csv-tool", "demo", 0);
  const b = reserveRunDir(runsDir, "/tmp/csv-tool", "demo", 0);
  expect(a).not.toBe(b);            // second run does not collide with the first
  expect(existsSync(a)).toBe(true); // both directories were actually created
  expect(existsSync(b)).toBe(true);
});
