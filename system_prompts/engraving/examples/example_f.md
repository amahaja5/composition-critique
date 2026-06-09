### Example F - tempo marking colliding with the staff

User message: `source_page_id: pg_tempo1`

Expected output:
```json
{
  "findings": [
    {
      "source_page_id": "pg_tempo1",
      "page_number": null,
      "system_number": 1,
      "measure_number": null,
      "staff_label": "staff 1",
      "location_label": "first system, above staff 1",
      "rule_id": "TEXT-11",
      "severity": "high",
      "evidence": "The tempo marking overlaps the top staff-lines, making the text and metronome marking hard to read.",
      "recommendation": "Raise the tempo marking above the staff with clear vertical separation.",
      "confidence": 0.91,
      "bbox_hint": null
    }
  ],
  "model_notes": ""
}
```
