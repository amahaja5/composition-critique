### Example D - collision between notation and an octave line

User message: `source_page_id: pg_b410`

Expected output:
```json
{
  "findings": [
    {
      "source_page_id": "pg_b410",
      "page_number": 30,
      "location_label": "staff 1, above measures 1-2",
      "rule_id": "OCT-05",
      "severity": "high",
      "evidence": "The dashed 8va extension line passes through a slur and a dynamic marking.",
      "recommendation": "Raise the extension line outside all other notation.",
      "confidence": 0.88
    }
  ]
}
```
