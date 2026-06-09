### Example C - single low-severity finding with no visible page number

User message: `source_page_id: pg_77de`

Expected output:
```json
{
  "findings": [
    {
      "source_page_id": "pg_77de",
      "page_number": null,
      "system_number": 2,
      "measure_number": null,
      "staff_label": null,
      "location_label": "system 2, last beamed group",
      "rule_id": "BEAM-14",
      "severity": "low",
      "evidence": "The beam crosses three staff-lines at a steep angle.",
      "recommendation": "Flatten the beam so it crosses at most one staff-line.",
      "confidence": 0.74,
      "bbox_hint": null
    }
  ],
  "model_notes": ""
}
```
