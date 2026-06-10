# Engraving Eval Labeling Guide

This workflow is for labeling score-page PNGs without writing code.

## 1. Generate labeling sheets

Run:

```sh
npm run eval:sheets -- --templates
```

Open `eval/golden/sheets/REVIEW.md` first. If a page says the detected system count is wrong, do not label that page yet; fix geometry and regenerate sheets.

## 2. Label a page

Open the sheet image in `eval/golden/sheets/`. Each system is marked `S1`, `S2`, and so on. Measures are marked `m1`, `m2`, and so on when the geometry code can detect barlines.

Open the matching JSON file in `eval/golden/truth/`. Add one object per real finding:

```json
{
  "gt_id": "p01-1",
  "system_number": 1,
  "measure_number": null,
  "staff_label": "Violin",
  "rule_id": "TEXT-11",
  "severity": "medium",
  "suppressed": false,
  "source": "labeled",
  "note": "tempo marking intersects the top staff"
}
```

Use `measure_number: null` if the sheet does not print measure ticks for that system.

## 3. Choose rule IDs and feedback fields

Use `eval/golden/sheets/RULE_CHEAT_SHEET.md`. If a region should be excluded from scoring, use:

```json
{
  "gt_id": "p01-ignore-1",
  "system_number": 2,
  "measure_number": null,
  "staff_label": null,
  "rule_id": "IGNORE",
  "severity": "low",
  "suppressed": false,
  "source": "labeled",
  "note": "Deliberate notation; exclude from scoring."
}
```

Use `suppressed: true` only when the finding is factually correct but not useful or not wanted in the product. Suppressed findings measure irrelevance; they are not false positives.

Use `known_false_positives` for negative assertions: cases where a model claimed a violation, but there is no real violation at that location. Do not put correct-but-unhelpful findings here.

```json
{
  "rule_id": "STAV-05",
  "system_number": 2,
  "measure_number": null,
  "staff_label": null,
  "source": "verdict",
  "note": "Spacing is fine; previous model run hallucinated crowding."
}
```

`source` should be `labeled`, `seeded`, `verdict`, or `user_miss`. Use `user_miss` for documented historical misses that the model should recover in future runs.

## 4. Exhaustive flag

Set `exhaustive: true` only when every real finding on the page has been listed. Use `false` for partial labeling; partial pages count toward precision but not recall.

## 5. Validate

Run:

```sh
npm run eval:validate-truth
```

Fix any errors before running model evals.
