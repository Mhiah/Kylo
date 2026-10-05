import assert from "node:assert/strict";
import { test } from "node:test";
import { extractNote, parseInsightRequest } from "../src/unifiedMain.js";

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

test("note JSON is found after a free model's thinking text", () => {
  const note = { summary: "Nvidia makes AI chips {big}.", reasonsToConsider: ["a"], reasonsToHoldOff: ["b"], read: "ok" };
  const raw = `Thinking Process:\n\n1. **Analyze** the {request} and draft {"summary": 1}...\n<think>{"summary":"draft"}</think>\n${JSON.stringify(note)}`;
  assert.deepEqual(extractNote(raw), note);
  assert.deepEqual(extractNote("```json\n" + JSON.stringify(note) + "\n```"), note);
  assert.equal(extractNote("Thinking Process: no JSON at all"), null);
});
