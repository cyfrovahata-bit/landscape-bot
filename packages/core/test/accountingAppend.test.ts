import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the production append function against a Sheets simulator that
// rejects repeatCell outside the grid, exactly like the reported API failure.
const source = readFileSync(new URL("../src/google/sheets.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source.slice(source.indexOf("export async function appendAccountingValues")), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

for (const capacity of [3007, 3008, 4000]) {
  test(`accounting append respects a ${capacity}-row grid`, async () => {
    let gridRows = capacity;
    let appended = false;
    let grew = false;
    const rows = [[1, "date", "name", "object", "work", 1.5], [2, "date", "name", "object", "work", 2]];
    const api = { spreadsheets: {
      get: async (args: any) => {
        assert.match(args.fields, /gridProperties.rowCount/);
        return { data: { properties: { locale: "uk_UA" }, sheets: [{ properties: {
          title: "БУХЗВІТ", sheetId: 7, gridProperties: { rowCount: gridRows },
        } }] } };
      },
      batchUpdate: async ({ requestBody }: any) => {
        for (const request of requestBody.requests) {
          if (request.appendDimension) {
            assert.equal(request.appendDimension.sheetId, 7);
            assert.equal(request.appendDimension.dimension, "ROWS");
            gridRows += request.appendDimension.length;
            grew = true;
          }
          if (request.repeatCell) {
            assert.ok((request.repeatCell.range.endRowIndex ?? gridRows) <= gridRows, "format exceeds grid");
          }
        }
      },
      values: { append: async (args: any) => {
        assert.ok(gridRows >= 3009);
        assert.equal(args.valueInputOption, "RAW");
        assert.equal(args.requestBody.values, rows);
        appended = true;
      } },
    } };
    const context = { exports: {} as any, getSheetsClient: () => api, config: { sheetId: "test" },
      sheetRef: (s: string) => `'${s}'`, withSheetsRetry: (_label: string, fn: () => unknown) => fn() };
    runInNewContext(code, context);
    await context.exports.appendAccountingValues("БУХЗВІТ", rows, 3007);
    assert.equal(appended, true);
    assert.equal(grew, capacity < 3009);
    assert.equal(gridRows, Math.max(capacity, 3009));
  });
}
