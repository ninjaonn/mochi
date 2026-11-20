// Where the mascot's speech bubble goes: above the mascot, or below it when
// there is no room, always inside the screen. Its tail points at the mascot.
const OVERLAP = 4;
const TAIL_MARGIN = 16;

const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

function bubblePosition(anchor, size, area) {
  const center = anchor.x + anchor.width / 2;
  const x = clamp(Math.round(center - size.width / 2), area.x, area.x + area.width - size.width);
  const above = anchor.y - size.height + OVERLAP;
  const side = above >= area.y ? 'above' : 'below';
  const y = side === 'above' ? above : anchor.y + anchor.height - OVERLAP;
  return {
    x,
    y: clamp(y, area.y, area.y + area.height - size.height),
    side,
    tailX: clamp(Math.round(center - x), TAIL_MARGIN, size.width - TAIL_MARGIN),
  };
}

module.exports = { bubblePosition };
