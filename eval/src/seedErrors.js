import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ensureDir, paths, writeJson } from "./common.js";

const execFileAsync = promisify(execFile);

const CASES = [
  ...makeCases("text_collision", "TEXT-11", 3),
  ...makeCases("dynamic_collision", "DYN-05", 3),
  ...makeCases("staff_spacing", "STAV-05", 3),
  ...makeCases("stem_direction", "STEM-01", 2),
  ...makeCases("compound_beaming", "BEAM-49", 2),
  ...makeCases("guitar_fingering", "GTR-01", 2),
];

await ensureDir(paths.seededPages);
await ensureDir(paths.seededTruth);

try {
  await execFileAsync("lilypond", ["--version"]);
} catch {
  console.error("[eval:seed] LilyPond is required. Install lilypond and retry.");
  process.exit(1);
}

for (const item of CASES) {
  const pageId = `seeded_${item.kind}_${String(item.index).padStart(2, "0")}`;
  const lyFile = path.join(paths.seededPages, `${pageId}.ly`);
  const outputBase = path.join(paths.seededPages, pageId);
  await writeFile(lyFile, renderLilypond(item));
  await execFileAsync("lilypond", [
    "--png",
    "-dresolution=150",
    "-dno-point-and-click",
    "-o",
    outputBase,
    lyFile,
  ]);
  await writeJson(path.join(paths.seededTruth, `${pageId}.json`), {
    page: pageId,
    labeler: "seed",
    labeled_at: new Date().toISOString().slice(0, 10),
    exhaustive: true,
    source: "seeded",
    title: `Seeded ${item.kind}`,
    instruments: item.kind === "guitar_fingering" ? ["guitar"] : ["piano"],
    doc_type: "score",
    findings: [
      {
        gt_id: `${pageId}-1`,
        system_number: 1,
        measure_number: item.measure,
        staff_label: item.kind === "guitar_fingering" ? "Guitar" : null,
        rule_id: item.ruleId,
        severity: item.severity,
        source: "seeded",
        suppressed: false,
        note: item.note,
      },
    ],
    known_false_positives: [],
  });
}

console.log(`Generated ${CASES.length} seeded eval cases.`);

function makeCases(kind, ruleId, count) {
  return Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    kind,
    measure: Math.min(index + 1, 4),
    note: noteForKind(kind),
    ruleId,
    severity: index % 2 ? "medium" : "low",
  }));
}

function renderLilypond(item) {
  const body = bodyForKind(item.kind, item.index);
  return String.raw`\version "2.24.0"
\paper {
  indent = 0\mm
  line-width = 150\mm
  ragged-right = ##f
  ragged-last = ##f
}
\layout {
  \context {
    \Score
    \override SpacingSpanner.common-shortest-duration = #(ly:make-moment 1/16)
  }
}
${body}
`;
}

function bodyForKind(kind, index) {
  if (kind === "text_collision") {
    return String.raw`\score {
  \new Staff \relative c'' {
    \clef treble
    \tempo \markup \override #'(baseline-skip . 0) \translate #'(0 . -4) "Allegro"
    c8 d e f g a b c
    c4 d e f
  }
}`;
  }

  if (kind === "dynamic_collision") {
    return String.raw`\score {
  \new Staff \relative c'' {
    \clef treble
    c8\< d e f\! \once \override DynamicText.extra-offset = #'(0 . 4) g\mf a b c
    c4\> b a\! g
  }
}`;
  }

  if (kind === "staff_spacing") {
    return String.raw`\score {
  \new PianoStaff \with {
    \override StaffGrouper.staff-staff-spacing.basic-distance = #1
    \override StaffGrouper.staff-staff-spacing.minimum-distance = #1
  } <<
    \new Staff \relative c'' { c4 d e f | g a b c | }
    \new Staff \relative c { \clef bass c4 d e f | g a b c | }
  >>
}`;
  }

  if (kind === "stem_direction") {
    return String.raw`\score {
  \new Staff \relative c' {
    \clef treble
    \stemDown c8 d e f \stemNeutral
    g a b c
  }
}`;
  }

  if (kind === "compound_beaming") {
    const meter = index % 2 ? "6/8" : "12/8";
    return String.raw`\score {
  \new Staff \relative c'' {
    \clef treble
    \time ${meter}
    [c8 d e f g a] | [a8 g f e d c] |
  }
}`;
  }

  return String.raw`\score {
  \new Staff \relative c'' {
    \clef treble
    c8^\markup \translate #'(0 . -4) "1" d e f
    g8^\markup \translate #'(0 . -4) "2" a b c
  }
}`;
}

function noteForKind(kind) {
  const notes = {
    compound_beaming: "Beam grouping crosses dotted-quarter pulse boundaries.",
    dynamic_collision: "Dynamic/hairpin placement collides with nearby notation.",
    guitar_fingering: "Fingering text overlaps the staff/beam region.",
    staff_spacing: "Two staves are vertically crowded.",
    stem_direction: "Stem direction is forced against ordinary single-voice convention.",
    text_collision: "Tempo or expressive text collides with the staff.",
  };
  return notes[kind] ?? "Seeded engraving issue.";
}
