// SI5's API judge (scripts/si5/judge-api.mjs): the three pieces of logic that decide whether a model's reply becomes a
// judgment file. A reply is parsed from whatever the model wraps it in, held to the packet's shape without coercing anything
// (a grade outside the scale stays wrong, and is reported, never fixed up), and a long packet is split by document.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReply, checkJudgments, splitJudgments, chunkDocs } from "../scripts/si5/judge-api-lib.mjs";

const ok = (id, over = {}) => ({ id, grade: 2, basis: "page", passage: "x".repeat(30), section: "page", reason: "supports a part", sourceType: "official_docs", versionStatus: "not_applicable", requirements: [], questions: [], ...over });
const reply = (q, ids, over = {}) => ({ schema: "fcpi.si5-judgments/v1", query: q, judgments: ids.map((i) => ok(i)), ...over });

test("a reply is read from a bare object, a code fence or surrounding prose, and nothing else is accepted", () => {
  const body = { a: 1, b: ["}", "{"] };
  assert.deepEqual(parseReply(JSON.stringify(body)), body);
  assert.deepEqual(parseReply("```json\n" + JSON.stringify(body) + "\n```"), body);
  assert.deepEqual(parseReply("Here is my judgment:\n" + JSON.stringify(body) + "\nHope that helps."), body);
  assert.throws(() => parseReply("no object here"), /no JSON object/);
  assert.throws(() => parseReply("{\"a\": 1,"), /not valid JSON/);
  assert.throws(() => parseReply(""), /no JSON object/);
});

test("a reply passes only when it judges exactly the packet's documents, once each, in the packet's shape", () => {
  assert.deepEqual(checkJudgments(reply("Q001", ["d1", "d2"]), "Q001", ["d1", "d2"]), []);
  const errs = (r, ids = ["d1", "d2"]) => checkJudgments(r, "Q001", ids).join(" | ");
  assert.match(errs(reply("Q002", ["d1", "d2"])), /query/);
  assert.match(errs(reply("Q001", ["d1"])), /missing d2/);
  assert.match(errs(reply("Q001", ["d1", "d2", "d3"])), /unexpected d3/);
  assert.match(errs(reply("Q001", ["d1", "d1", "d2"])), /duplicate d1/);
  assert.match(errs({ ...reply("Q001", ["d1", "d2"]), schema: "other" }), /schema/);
  assert.match(errs({ ...reply("Q001", []), judgments: "none" }), /judgments is not an array/);
});

test("the scale is held as written: null is a grade of unjudged, and 4, a numeric string or a missing grade is an error", () => {
  const one = (over) => checkJudgments(reply("Q001", ["d1"], { judgments: [ok("d1", over)] }), "Q001", ["d1"]).join(" | ");
  assert.equal(one({ grade: null, passage: null, basis: "none" }), "");
  assert.equal(one({ grade: 0 }), "");
  assert.match(one({ grade: 4 }), /grade/);
  assert.match(one({ grade: "2" }), /grade/);
  assert.match(one({ grade: undefined }), /grade/);
  assert.match(one({ basis: "memory" }), /basis/);
  assert.match(one({ sourceType: "blog" }), /sourceType/);
  assert.match(one({ versionStatus: "maybe" }), /versionStatus/);
  assert.match(one({ reason: "" }), /reason/);
});

test("a partial reply keeps its valid judgments and names what to ask again: only the documents it left out or got wrong", () => {
  const ids = ["d1", "d2", "d3"];
  const all = splitJudgments(reply("Q001", ids), "Q001", ids);
  assert.deepEqual(all.valid.map((j) => j.id), ids);
  assert.deepEqual(all.problems, []);
  const part = splitJudgments(reply("Q001", ["d1"]), "Q001", ids);
  assert.deepEqual(part.valid.map((j) => j.id), ["d1"], "an early stop keeps the one judgment it gave");
  const bad = splitJudgments({ ...reply("Q001", []), judgments: [ok("d1"), ok("d2", { grade: 4 }), ok("d3")] }, "Q001", ids);
  assert.deepEqual(bad.valid.map((j) => j.id), ["d1", "d3"], "a judgment off the scale is left out, not repaired");
  assert.match(bad.problems.join(" | "), /d2: grade/);
  const dup = splitJudgments({ ...reply("Q001", []), judgments: [ok("d1", { grade: 1 }), ok("d1", { grade: 3 }), ok("dX")] }, "Q001", ids);
  assert.deepEqual(dup.valid.map((j) => [j.id, j.grade]), [["d1", 1]], "the first judgment of a document stands");
  assert.match(dup.problems.join(" | "), /duplicate d1.*unexpected dX|unexpected dX.*duplicate d1/);
  const other = splitJudgments(reply("Q002", ids), "Q001", ids);
  assert.deepEqual(other.valid, [], "a reply for another query yields nothing");
  assert.match(other.problems.join(" | "), /query/);
});

test("a long packet is split by document into groups under the limit, in order, and a document over it stands alone", () => {
  const docs = [["a", 40], ["b", 40], ["c", 40], ["d", 150], ["e", 10]].map(([name, size]) => ({ name, text: "x".repeat(size * 4) }));
  const groups = chunkDocs(docs, 100);
  assert.deepEqual(groups.map((g) => g.map((d) => d.name)), [["a", "b"], ["c"], ["d"], ["e"]]);
  assert.deepEqual(chunkDocs(docs.slice(0, 2), 1000).map((g) => g.length), [2], "a packet under the limit is one request");
  assert.deepEqual(chunkDocs([], 100), []);
  assert.ok(chunkDocs(docs, 100).every((g) => g.length > 0), "no empty group");
});
