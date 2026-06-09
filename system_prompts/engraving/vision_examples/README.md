# Vision Few-Shot Examples

Add one manifest entry per image/gold-label pair:

```json
{
  "image": "example.png",
  "gold": "example.json"
}
```

Optional fields:
- `id`: defaults to the image filename without extension.
- `source_page_id`: defaults to `fewshot_{id}`.
- `media_type`: inferred from `.png`, `.jpg`, `.jpeg`, `.gif`, or `.webp`.
- `prompt`: defaults to `Critique this engraving.`

Gold files must be strict JSON using the engraving findings schema. Any
`rule_id` cited by a gold finding must be loaded by the routed prompt.
