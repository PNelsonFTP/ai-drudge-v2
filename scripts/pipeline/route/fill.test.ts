import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { starvationFill } from "./fill";

describe("starvationFill", () => {
  it("leaves a section alone when it already has minItems", () => {
    const got = starvationFill(["a", "b", "c"], ["x", "y"], 3);
    assert.deepEqual(got.rows, ["a", "b", "c"]);
    assert.deepEqual(got.used, []);
    assert.deepEqual(got.unused, ["x", "y"]);
  });

  it("tops up to minItems in reserve order, and never beyond", () => {
    const got = starvationFill(["a"], ["x", "y", "z"], 3);
    assert.deepEqual(got.rows, ["a", "x", "y"]);
    assert.deepEqual(got.used, ["x", "y"]);
    assert.deepEqual(got.unused, ["z"]);
  });

  it("uses what there is when the reserve is short", () => {
    assert.deepEqual(starvationFill([], ["x"], 4).rows, ["x"]);
    assert.deepEqual(starvationFill([], [], 4).rows, []);
  });

  it("skips candidates the caller rejects and keeps looking", () => {
    const got = starvationFill(["a"], ["bad1", "ok1", "bad2", "ok2", "ok3"], 3, (c) => c.startsWith("ok"));
    assert.deepEqual(got.rows, ["a", "ok1", "ok2"]);
    assert.deepEqual(got.unused, ["bad1", "bad2", "ok3"]);
  });

  it("shows the accept callback the rows chosen so far and does not mutate its inputs", () => {
    const rows = ["a"];
    const reserve = ["x", "y"];
    const seen: number[] = [];
    starvationFill(rows, reserve, 3, (_c, soFar) => {
      seen.push(soFar.length);
      return true;
    });
    assert.deepEqual(seen, [1, 2]);
    assert.deepEqual(rows, ["a"]);
    assert.deepEqual(reserve, ["x", "y"]);
  });
});
