// Lays changes out on lanes for the jj-graph panel to draw. Changes come in
// jj's order, every child before its parents, each with its edges from
// graph.js's graphEdges: [{ to, elided }]. A lane is a column waiting for one
// commit, and it keeps its column until that commit arrives, so lines bend
// only where changes fork or merge. An elided edge, through changes the
// revset hides, keeps its lane all the same, drawn dashed, as jj draws one
// line through "(elided revisions)"; that is what keeps a second lineage out
// of the first one's column. An edge to nothing shown ({ to: null }) is a
// short dashed stub. The approach follows herdr-git-graph's lanes.js
// (https://github.com/rabeeh-ta/herdr-git-graph, MIT).
//
// Each row is { lane, segments }, with a segment [fromLane, fromY, toLane,
// toY, colorLane, dashed] and y 0 at the top of the row, 0.5 at the change's
// node and 1 at the bottom. `width` is the most lanes any row needs.
export function layout(changes) {
  const lanes = []; // the commit each column waits for, or null
  const dashed = []; // whether that column's line runs through elided changes
  const free = () => { const i = lanes.indexOf(null); return i < 0 ? lanes.length : i; };
  let width = 1;
  const rows = changes.map(({ commit, edges }) => {
    const before = lanes.slice(), wasDashed = dashed.slice(), segments = [];
    let lane = before.indexOf(commit);
    if (lane < 0) { lane = free(); lanes[lane] = commit; } // a head: nothing above it
    before.forEach((waiting, j) => {
      if (waiting == null) return;
      if (waiting !== commit) return segments.push([j, 0, j, 1, j, Boolean(wasDashed[j])]);
      segments.push([j, 0, lane, 0.5, j, Boolean(wasDashed[j])]);
      if (j !== lane) { lanes[j] = null; dashed[j] = false; } // a line that ends here
    });
    lanes[lane] = null; dashed[lane] = false;
    edges.forEach(({ to, elided }, n) => {
      if (to == null) {
        const k = n === 0 ? lane : free();
        return segments.push([lane, 0.5, k, 1, k, true]);
      }
      // The first edge continues this lane, even when another lane already
      // waits for the same commit: the two meet where that commit's row draws.
      let k = n === 0 ? lane : lanes.indexOf(to);
      if (k < 0) k = free();
      dashed[k] = lanes[k] === to ? dashed[k] && elided : elided;
      lanes[k] = to;
      segments.push([lane, 0.5, k, 1, k, elided]);
    });
    width = Math.max(width, before.length, lanes.length);
    while (lanes.length && lanes[lanes.length - 1] === null) { lanes.pop(); dashed.length = lanes.length; }
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
