/** Graph layout encoding shared by the engine (which lays it out) and the graph webview (which draws it). */

export const EDGE_PASS = 0;
export const EDGE_IN = 1;
export const EDGE_OUT = 2;

export const ROW_MERGE = 1;
/** No parents: an orphan root (or the repository's first commit). */
export const ROW_ROOT = 2;
/** A parent is outside the table: a shallow clone's boundary. */
export const ROW_BOUNDARY = 4;
/** No child in the table: a branch tip (or a commit only a tag or HEAD points at). */
export const ROW_TIP = 8;
/** The temporary node of a merge / rebase / pick in progress (conflict map), not a commit. */
export const ROW_PENDING = 16;

/** Id of the conflict map's temporary node. */
export const PENDING_SHA = '0'.repeat(40);

/** Lane colours cycle by lane index (--gvx-lane-1 … 8). */
export const LANE_COLORS = 8;

/** Edge packed in 32 bits: kind (2) | from lane (15) | to lane (15). */
export const packEdge = (kind: number, from: number, to: number) => ((kind << 30) | (from << 15) | to) >>> 0;
export const edgeKind = (e: number) => e >>> 30;
export const edgeFrom = (e: number) => (e >>> 15) & 0x7fff;
export const edgeTo = (e: number) => e & 0x7fff;

/** Which commits the graph shows: everything, HEAD's history, one branch's history (`ref` is a full name under refs/heads/ or refs/remotes/), or one file's. */
export type GraphView = ({ kind: 'all' } | { kind: 'branch' } | { kind: 'ref'; ref: string } | { kind: 'file'; path: string }) & {
  /** An operation in progress: a temporary node joining these commits is drawn at the top. */
  pending?: { parents: string[] };
};
