// Lays changes out on lanes for the jj-graph panel to draw. Changes come in
// jj's order, every child before its parents. A lane is a column waiting for
// one commit, and it keeps its column until that commit arrives, so lines bend
// only where changes fork or merge. A parent jj left out of the log (its
// revset elides it) gets a short dashed stub instead of a lane, where jj's own
// graph prints "~". The approach follows herdr-git-graph's lanes.js
// (https://github.com/rabeeh-ta/herdr-git-graph, MIT).
//
// Each row is { lane, segments }, with a segment [fromLane, fromY, toLane,
// toY, colorLane, dashed] and y 0 at the top of the row, 0.5 at the change's
// node and 1 at the bottom. `width` is the most lanes any row needs.
export function layout(changes) {
  const shown = new Set(changes.map((c) => c.commit));
  const lanes = []; // the commit each column waits for, or null
  const free = () => { const i = lanes.indexOf(null); return i < 0 ? lanes.length : i; };
  let width = 1;
  const rows = changes.map(({ commit, parents }) => {
    const before = lanes.slice(), segments = [];
    let lane = before.indexOf(commit);
    if (lane < 0) { lane = free(); lanes[lane] = commit; } // a head: nothing above it
    before.forEach((waiting, j) => {
      if (waiting == null) return;
      if (waiting !== commit) return segments.push([j, 0, j, 1, j, false]);
      segments.push([j, 0, lane, 0.5, j, false]);
      if (j !== lane) lanes[j] = null; // a line that ends here
    });
    lanes[lane] = null;
    parents.forEach((parent, n) => {
      if (!shown.has(parent)) {
        const k = n === 0 ? lane : free();
        return segments.push([lane, 0.5, k, 1, k, true]);
      }
      // The first parent continues this lane, even when another lane already
      // waits for it: the two meet where that parent's row draws.
      let k = n === 0 ? lane : lanes.indexOf(parent);
      if (k < 0) k = free();
      lanes[k] = parent;
      segments.push([lane, 0.5, k, 1, k, false]);
    });
    width = Math.max(width, before.length, lanes.length);
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    return { lane, segments };
  });
  return { rows, width };
}

// Where lanes sit in a row's graph cell, in the units an element's w() takes.
export const LANE = 14, PAD = 8;
export const laneX = (lane) => PAD + lane * LANE + LANE / 2;
export const graphWidth = (lanes) => PAD * 2 + lanes * LANE;

// A segment's path points as percentages of the graph cell. paint_path takes
// pixels, which the window's zoom doesn't scale the way it scales elements, so
// percentages are what keep the lines on the nodes. A bend gets two control
// points halfway down, so it leaves and arrives vertically.
export function segmentPath([a, ya, b, yb], lanes) {
  const w = graphWidth(lanes), x = (lane) => `${(laneX(lane) / w) * 100}%`, y = (v) => `${v * 100}%`;
  if (a === b) return { from: [x(a), y(ya)], to: [x(b), y(yb)] };
  const mid = (ya + yb) / 2;
  return { from: [x(a), y(ya)], to: [x(b), y(yb)], controls: [[x(a), y(mid)], [x(b), y(mid)]] };
}
