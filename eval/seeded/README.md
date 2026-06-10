# Seeded Engraving Errors

Run:

```sh
npm run eval:seed
```

This requires LilyPond 2.24 or newer on `PATH`. The generator writes LilyPond
sources and rendered PNGs to `eval/seeded/pages/`, plus auto-generated truth JSON
to `eval/seeded/truth/`.

Seeded metrics are reported separately from real golden pages because they are
cleaner than real-world notation and can flatter recall.

