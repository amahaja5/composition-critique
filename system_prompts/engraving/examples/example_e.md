### Example E - lyric collision

User message: `source_page_id: pg_v023`

Expected output:
```json
{
  "findings": [
    {
      "source_page_id": "pg_v023",
      "page_number": 7,
      "system_number": 4,
      "measure_number": 1,
      "staff_label": "staff 2",
      "location_label": "system 4, staff 2, lyrics under measure 1",
      "rule_id": "LYRC-02",
      "severity": "medium",
      "evidence": "The lyric syllable touches a down-stem and is partly obscured.",
      "recommendation": "Lower or respell the lyric spacing so text clears the stem.",
      "confidence": 0.86,
      "bbox_hint": null
    }
  ],
  "model_notes": ""
}
```

---
