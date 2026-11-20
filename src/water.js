// Water reminder timing. The mascot nudges when a sip is due, then again every
// few minutes until the user clicks it. Nobody is nudged while away.
const DEFAULT_MINUTES = 45;
const MIN_MINUTES = 5;
const MAX_MINUTES = 240;
const REPEAT_MS = 5 * 60000;
const DEFAULT_MESSAGE = 'จิบน้ำหน่อยงับ';
const MAX_MESSAGE = 60;

// 0 means off. Anything else is kept to a sensible range.
function cleanMinutes(value) {
  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, minutes));
}

// Blank goes back to the default. Counts characters, so emoji stay whole.
function cleanMessage(text) {
  const message = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return [...message].slice(0, MAX_MESSAGE).join('').trim() || DEFAULT_MESSAGE;
}

function shouldNudge({ minutes, lastSip, lastNudge, now, asleep }) {
  if (!minutes || asleep || now - lastSip < minutes * 60000) return false;
  return !lastNudge || now - lastNudge >= REPEAT_MS;
}

module.exports = { DEFAULT_MINUTES, MIN_MINUTES, MAX_MINUTES, DEFAULT_MESSAGE, MAX_MESSAGE, cleanMinutes, cleanMessage, shouldNudge };
