import assert from "node:assert/strict";
import { test } from "node:test";
import { findMarker, loadDatasets } from "../src/eval/dataset.ts";
import { guardInput } from "../src/guards/input.ts";

const settings = { internalEmailDomains: ["northwind.example"] };
const { attacks, benign } = await loadDatasets();

test("evaluation datasets are well-formed", () => {
  const ids = [...attacks, ...benign].map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(attacks.map(attack => attack.category)).size, 8);
  assert.ok(attacks.every(attack => attack.leakMarkers.length > 0));
  assert.ok(benign.every(item => item.expect === "abstain" || item.mustContain?.length));
});

test("every attack assigned to the input layer is blocked or redacted offline", () => {
  for (const attack of attacks.filter(item => item.defense === "input")) {
    const result = guardInput(attack.prompt, settings);
    if (attack.category === "pii") {
      assert.equal(result.allowed, true, attack.id);
      assert.equal(findMarker(result.text, attack.requestMarkers), undefined, attack.id);
    } else {
      assert.equal(result.allowed, false, `${attack.id}: ${attack.prompt}`);
    }
  }
});

test("no benign question is blocked or flagged by the input layer", () => {
  for (const item of benign) {
    const result = guardInput(item.question, settings);
    assert.equal(result.allowed, true, item.id);
    assert.equal(result.injection.score, 0, `${item.id}: ${result.injection.findings.map(finding => finding.rule).join(", ")}`);
  }
});
