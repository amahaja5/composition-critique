\version "2.24.0"
\score {
  \new PianoStaff <<
    \new Staff \relative c'' { c4 d e f | g a b c | }
    \new Staff \relative c { \clef bass c4 d e f | g a b c | }
  >>
}

