// api/target.js
export default function handler(req, res) {
  // Friday May 29, 2026, 6:00 PM ET = 22:00 UTC
  const target = new Date("2026-05-29T22:00:00Z").toISOString();
  res.status(200).json({ target });
}
