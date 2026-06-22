/**
 * Small helpers for composing *parameterized* SQL.
 *
 * Every value supplied by a caller is passed through bind parameters
 * (`$1, $2, ...`); column/table names are only ever drawn from hard-coded
 * literals in the repository layer, never from caller input. This keeps the
 * data-access layer free of string interpolation of values and therefore safe
 * from SQL injection. (Requirement 15.3)
 */

/** A built statement: SQL text plus the ordered bind values. */
export interface BuiltStatement {
  text: string;
  values: unknown[];
}

/**
 * Assert that an `INSERT ... RETURNING *` (or similar) produced exactly the
 * expected row. The `pg` driver types `rows[0]` as possibly-undefined under
 * `noUncheckedIndexedAccess`; this narrows it and fails loudly if a statement
 * that must return a row did not.
 */
export function requireRow<R>(rows: readonly R[], context: string): R {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Expected a returned row from ${context} but none was returned`);
  }
  return row;
}

/**
 * Build a parameterized `INSERT ... RETURNING *` statement.
 *
 * `columns` maps column name -> value. Keys with `undefined` values are
 * omitted entirely so the database applies its column default; `null` is kept
 * and bound explicitly. Column names come from repository literals only.
 */
export function buildInsert(
  table: string,
  columns: Record<string, unknown>,
): BuiltStatement {
  const entries = Object.entries(columns).filter(([, v]) => v !== undefined);
  const names = entries.map(([name]) => name);
  const values = entries.map(([, value]) => value);
  const placeholders = names.map((_, i) => `$${i + 1}`);

  const text =
    `INSERT INTO ${table} (${names.join(', ')}) ` +
    `VALUES (${placeholders.join(', ')}) RETURNING *`;

  return { text, values };
}

/**
 * Build a parameterized `UPDATE ... SET ... WHERE <whereCol> = $n RETURNING *`.
 *
 * `set` maps column -> new value (undefined entries are skipped). The WHERE
 * predicate matches a single column to `whereValue`. Throws if `set` is empty.
 */
export function buildUpdateById(
  table: string,
  set: Record<string, unknown>,
  whereCol: string,
  whereValue: unknown,
): BuiltStatement {
  const entries = Object.entries(set).filter(([, v]) => v !== undefined);
  if (entries.length === 0) {
    throw new Error(`buildUpdateById: no columns to update for table "${table}"`);
  }

  const assignments = entries.map(([name], i) => `${name} = $${i + 1}`);
  const values = entries.map(([, value]) => value);
  values.push(whereValue);

  const text =
    `UPDATE ${table} SET ${assignments.join(', ')} ` +
    `WHERE ${whereCol} = $${values.length} RETURNING *`;

  return { text, values };
}
