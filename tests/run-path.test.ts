import { expect, test } from "vitest";
import { projectSlug, runDate, buildRunDir } from "../src/state/run-path.js";

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
