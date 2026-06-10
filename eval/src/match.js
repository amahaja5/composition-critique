export function matchPage({ predictions = [], truth = {} }) {
  const truthFindings = Array.isArray(truth.findings) ? truth.findings : [];
  const ignoreFindings = truthFindings.filter((finding) => finding.rule_id === "IGNORE");
  const reportableTruth = truthFindings.filter(
    (finding) => finding.rule_id !== "IGNORE" && !finding.suppressed,
  );
  const suppressedTruth = truthFindings.filter(
    (finding) => finding.rule_id !== "IGNORE" && finding.suppressed,
  );
  const knownFalsePositiveTruth = Array.isArray(truth.known_false_positives)
    ? truth.known_false_positives
    : [];
  const filteredPredictions = predictions
    .map((prediction, index) => ({ index, prediction }))
    .filter(
      ({ prediction }) => !ignoreFindings.some((ignore) => locationCompatible(prediction, ignore)),
    );
  const usedPredictions = new Set();
  const usedTruth = new Set();

  const suppressedHits = assignMatches({
    predictions: filteredPredictions,
    truth: suppressedTruth,
    usedPredictions,
  }).map(markMatch("suppressed_hit"));

  const confirmedFalsePositives = assignMatches({
    predictions: filteredPredictions,
    truth: knownFalsePositiveTruth,
    usedPredictions,
  }).map(markMatch("confirmed_false_positive"));

  const matches = assignMatches({
    predictions: filteredPredictions,
    truth: reportableTruth,
    usedPredictions,
    usedTruth,
  }).map((match) => ({
    measure_match: measureMatchLabel(match.measureScore),
    prediction: match.prediction,
    severity_match:
      String(match.prediction.severity ?? "").toLowerCase() ===
      String(match.truth.severity ?? "").toLowerCase(),
    truth: match.truth,
  }));

  const unmatchedPredictions = filteredPredictions
    .filter(({ index }) => !usedPredictions.has(index))
    .map(({ prediction }) => prediction);
  const falsePositives = truth.exhaustive ? unmatchedPredictions : [];
  const unverified = truth.exhaustive ? [] : unmatchedPredictions;
  const unmatchedTruth = reportableTruth.filter((_, index) => !usedTruth.has(index));
  const falseNegatives = truth.exhaustive ? unmatchedTruth : [];

  return {
    confirmedFalsePositives,
    dropped_predictions: predictions.length - filteredPredictions.length,
    falseNegatives,
    falsePositives,
    matches,
    nearMisses: classifyNearMisses([...falsePositives, ...unverified], unmatchedTruth),
    suppressedHits,
    unverified,
  };
}

export function measureCompatibilityScore(predicted, expected) {
  const pred = nullableNum(predicted);
  const gt = nullableNum(expected);
  if (pred === null || gt === null) return 1;
  if (pred === gt) return 3;
  if (Math.abs(pred - gt) <= 1) return 2;
  return 0;
}

export function locationCompatible(prediction, finding) {
  if (num(prediction.system_number) !== num(finding.system_number)) return false;
  const staff = cleanText(finding.staff_label);
  if (staff && cleanText(prediction.staff_label) !== staff) return false;
  return measureCompatibilityScore(prediction.measure_number, finding.measure_number) > 0;
}

function assignMatches({ predictions, truth, usedPredictions, usedTruth = null }) {
  const candidates = [];

  for (const { index: predictionIndex, prediction } of predictions) {
    if (usedPredictions.has(predictionIndex)) continue;
    for (const [truthIndex, gt] of truth.entries()) {
      if (usedTruth?.has(truthIndex)) continue;
      if (prediction.rule_id !== gt.rule_id) continue;
      if (num(prediction.system_number) !== num(gt.system_number)) continue;
      const measureScore = measureCompatibilityScore(
        prediction.measure_number,
        gt.measure_number,
      );
      if (!measureScore) continue;
      candidates.push({
        measureScore,
        prediction,
        predictionIndex,
        truth: gt,
        truthIndex,
      });
    }
  }

  candidates.sort((a, b) => b.measureScore - a.measureScore);
  const matches = [];
  const localTruth = new Set();
  for (const candidate of candidates) {
    if (
      usedPredictions.has(candidate.predictionIndex) ||
      localTruth.has(candidate.truthIndex) ||
      usedTruth?.has(candidate.truthIndex)
    ) {
      continue;
    }
    usedPredictions.add(candidate.predictionIndex);
    localTruth.add(candidate.truthIndex);
    usedTruth?.add(candidate.truthIndex);
    matches.push(candidate);
  }
  return matches;
}

function markMatch(kind) {
  return (match) => ({
    kind,
    measure_match: measureMatchLabel(match.measureScore),
    prediction: match.prediction,
    truth: match.truth,
  });
}

function classifyNearMisses(predictions, unmatchedTruth) {
  const nearMisses = [];
  for (const prediction of predictions) {
    const sameRule = unmatchedTruth.find(
      (gt) => gt.rule_id === prediction.rule_id && num(gt.system_number) !== num(prediction.system_number),
    );
    if (sameRule) {
      nearMisses.push({
        kind: "right_rule_wrong_system",
        prediction,
        truth: sameRule,
      });
      continue;
    }

    const sameLocation = unmatchedTruth.find(
      (gt) =>
        gt.rule_id !== prediction.rule_id &&
        locationCompatible(prediction, gt),
    );
    if (sameLocation) {
      nearMisses.push({
        kind: "right_location_wrong_rule",
        prediction,
        truth: sameLocation,
      });
    }
  }
  return nearMisses;
}

function measureMatchLabel(score) {
  if (score === 3) return "exact";
  if (score === 2) return "adjacent";
  return "null_compatible";
}

function nullableNum(value) {
  if (value === null || value === undefined || value === "") return null;
  return num(value);
}

function num(value) {
  const number = Number.parseInt(value ?? "", 10);
  return Number.isFinite(number) ? number : null;
}

function cleanText(value) {
  return String(value ?? "").trim().toLowerCase();
}
