// The five fields a finished task keeps in history, and nothing else.
// One definition, shared by the item store (crossing a task off) and migrate
// (seeding history from files that predate it), so the two can never drift.
export function toHistory({ id, text, quad, createdAt, doneAt }) {
  return { id, text, quad, createdAt, doneAt };
}
