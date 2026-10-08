import assert from "node:assert/strict";
import { test } from "node:test";
import { extractNote, jobTask, parseInsightRequest, tidy, tidyNote } from "../src/unifiedMain.js";

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

test("jobTask unwraps a paid ERC-8183 job prompt to the buyer's task", () => {
  const task = '{"action":"insight","ticker":"NVDA"}';
  const wrapped = "You accepted and were paid for the following job. Produce the deliverable now.\n\nJOB CONTEXT:\n" +
    JSON.stringify({ task, terms: { price: "0.05" } });
  assert.equal(jobTask(wrapped), task);
  assert.deepEqual(parseInsightRequest(jobTask(wrapped)!), { ticker: "NVDA" });
  assert.equal(jobTask(wrapped.replace(JSON.stringify(task), JSON.stringify({ action: "insight", ticker: "KO" }))), '{"action":"insight","ticker":"KO"}');
  assert.equal(jobTask('{"action":"insight","ticker":"NVDA"}'), null);
  assert.equal(jobTask("JOB CONTEXT:\njob 7"), null);
});

test("tidy removes dashes and commas before and", () => {
  assert.equal(tidy("Strong sales — but pricey, and volatile."), "Strong sales, but pricey and volatile.");
  assert.equal(tidy("Range $150–$241 in 2024—2025"), "Range $150–$241 in 2024–2025");
  assert.equal(tidy("Chips, cloud, and AI"), "Chips, cloud and AI");
  assert.deepEqual(tidyNote({ summary: "A — b", reasonsToConsider: ["x, and y"], n: 3 }), { summary: "A, b", reasonsToConsider: ["x and y"], n: 3 });
});
