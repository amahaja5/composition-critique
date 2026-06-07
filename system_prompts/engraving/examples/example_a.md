### Example A - a page with two clear violations

User message: `source_page_id: pg_a91f`

Expected output:
```json
{
  "findings": [
    {
      "source_page_id": "pg_a91f",
      "page_number": 12,
      "location_label": "system 1, measure 2, beat 3",
      "rule_id": "CHRD-13",
      "severity": "high",
      "evidence": "A flat sign is printed to the right of the notehead it modifies.",
      "recommendation": "Move the accidental to the left of its notehead.",
      "confidence": 0.93
    },
    {
      "source_page_id": "pg_a91f",
      "page_number": 12,
      "location_label": "system 3, beamed group on staff 2",
      "rule_id": "BEAM-03",
      "severity": "medium",
      "evidence": "Inner beam stops short; the middle stems do not reach the second beam.",
      "recommendation": "Extend all stems through every inner beam to the outer beam.",
      "confidence": 0.81
    }
  ]
}
```
