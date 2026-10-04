import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInsightRequest } from "../src/unifiedMain.js";

test("insight request without facts", () => {
  assert.deepEqual(parseInsightRequest('{"action":"insight","ticker":"nvda"}'), { ticker: "NVDA" });
});

test("insight request carries facts from the web app", () => {
  const r = parseInsightRequest(JSON.stringify({ action: "insight", ticker: "KO", facts: { sharePrice: 66.4 } }));
  assert.deepEqual(r, { ticker: "KO", facts: { sharePrice: 66.4 } });
});

test("non-object facts are ignored, bad tickers rejected", () => {
  assert.deepEqual(parseInsightRequest('{"action":"insight","ticker":"KO","facts":[1,2]}'), { ticker: "KO" });
  assert.equal(parseInsightRequest('{"action":"insight","ticker":"DROP TABLE"}'), null);
  assert.equal(parseInsightRequest("hello"), null);
});
