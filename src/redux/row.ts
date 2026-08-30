import { otherPaths, rowName } from "../tree/placement.ts";
import type { Change, Row, RowOp, RowSubject } from "../timeline/timeline.ts";

/** One change as the panel prints it: the store spelled for a reader, and what it did. */
type DrawnChange = {
  label: string;
  op: RowOp;
  /** Every other chain that reaches the store, where the developer holds it in more than one. */
  also?: string[] | undefined;
  path?: string | undefined;
  from?: string | undefined;
};

export type RowMessage = {
  type: string;
  action: { type: string; changes: DrawnChange[] };
  timestamp: number;
};

/**
 * `type` sits at both levels on purpose. The extension replaces a whole action that carries no
 * top-level `type` with `{ type: "update" }`, and only the nested shape keeps our `timestamp`,
 * which is what lets a row flushed later keep the time of the write that caused it.
 */
export function renderRow(row: Row): RowMessage {
  const type = rowType(row);

  return {
    type,
    action: { type, changes: row.changes.map(renderChange) },
    timestamp: row.timestamp,
  };
}

/**
 * From the row's own subject and op, never from a change: a recompute joins the open row, so every
 * change past the first belongs to another store and must not name the row.
 */
function rowType(row: Row): string {
  const named = `${subjectName(row.subject)}/${row.op}`;

  return row.path === undefined ? named : `${named}:${row.path}`;
}

function subjectName(subject: RowSubject): string {
  switch (subject.kind) {
    case "store":
      return rowName(subject.entry);
    case "path":
      return subject.path;
    case "home":
      return subject.home;
    default: {
      const unreachable: never = subject;

      throw new Error(`unhandled row subject: ${JSON.stringify(unreachable)}`);
    }
  }
}

function renderChange(change: Change, index: number): DrawnChange {
  const drawn: DrawnChange = { label: change.entry.label, op: change.op };
  const also = otherPaths(change.entry);

  if (also.length > 0) {
    drawn.also = also;
  }

  if (change.path !== undefined) {
    drawn.path = change.path;
  }

  /** A follower that joined a row names the change before it, even where that change is itself. */
  if (change.op === "computed" && index > 0) {
    drawn.from = change.from?.label;
  }

  return drawn;
}
