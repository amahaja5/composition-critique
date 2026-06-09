import assert from "node:assert/strict";
import {
  displayToNormalized,
  normalizedToDisplay,
  normalizedToPdfPoints,
} from "../src/lib/coords.js";
import { snapFindingToGeometry } from "../src/lib/scoreGeometry.js";

const displaySize = { width: 1000, height: 2000 };
const normalized = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
const display = normalizedToDisplay(normalized, displaySize);

assert.deepEqual(display, {
  height: 800,
  width: 300,
  x: 100,
  y: 400,
});
assert.deepEqual(displayToNormalized(display, displaySize), normalized);
assert.deepEqual(normalizedToPdfPoints(normalized, displaySize), {
  height: 800,
  width: 300,
  x: 100,
  y: 800,
});

const geometry = {
  height: 1000,
  systems: [
    {
      index: 1,
      measures: [
        { index: 1, xLeft: 100, xRight: 300 },
        { index: 2, xLeft: 300, xRight: 520 },
      ],
      staves: [
        { index: 1, yBottom: 190, yTop: 120 },
        { index: 2, yBottom: 300, yTop: 230 },
      ],
      xLeft: 80,
      xRight: 540,
      yBottom: 330,
      yTop: 90,
    },
  ],
  width: 800,
};

const snapped = snapFindingToGeometry(
  {
    measure_number: 2,
    staff_label: "Guitar",
    system_number: 1,
  },
  geometry,
);

assert.equal(snapped.unlocalized, false);
assert.deepEqual(snapped.rect, {
  height: 0.07,
  width: 0.275,
  x: 0.375,
  y: 0.23,
});

const unlocalized = snapFindingToGeometry({ system_number: 9 }, geometry);
assert.equal(unlocalized.unlocalized, true);

console.log("Overlay geometry checks passed.");
