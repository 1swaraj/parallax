// A stand-in for the indexing store Ponder gives handlers (context.db), in memory, for handler tests: find, insert
// (throwing on a conflict unless told otherwise), update and delete by primary key, as Ponder's do.

type Row = Record<string, unknown>;
type Change = Row | ((row: Row) => Row);

export function fakeDb(primaryKeys: Map<object, string[]>) {
  const tables = new Map<object, Map<string, Row>>();
  const rowsOf = (table: object) => {
    if (!primaryKeys.has(table)) {
      throw new Error('Unknown table: add its primary key');
    }
    let rows = tables.get(table);
    if (!rows) {
      rows = new Map();
      tables.set(table, rows);
    }
    return rows;
  };
  const keyOf = (table: object, values: Row) =>
    JSON.stringify(primaryKeys.get(table)!.map((column) => String(values[column])));
  const apply = (row: Row, change: Change) => ({
    ...row,
    ...(typeof change === 'function' ? change(row) : change),
  });

  function insert(table: object) {
    return {
      values(values: Row | Row[]) {
        const list = Array.isArray(values) ? values : [values];
        const write = (onConflict: (existing: Row, value: Row) => Row | null) => {
          const rows = rowsOf(table);
          const written = list.map((value) => {
            const key = keyOf(table, value);
            const existing = rows.get(key);
            const row = existing ? onConflict(existing, value) : { ...value };
            if (row) {
              rows.set(key, row);
            }
            return row;
          });
          return Array.isArray(values) ? written : written[0];
        };
        const run = () =>
          write((_, value) => {
            throw new Error(`Unique constraint failed for ${keyOf(table, value)}`);
          });
        return {
          then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
            try {
              return Promise.resolve(run()).then(resolve, reject);
            } catch (error) {
              return Promise.reject(error).then(resolve, reject);
            }
          },
          onConflictDoNothing: async () => write(() => null),
          onConflictDoUpdate: async (change: Change) =>
            write((existing) => apply(existing, change)),
        };
      },
    };
  }

  const db = {
    async find(table: object, key: Row) {
      const row = rowsOf(table).get(keyOf(table, key));
      return row ? { ...row } : null;
    },
    insert,
    update(table: object, key: Row) {
      return {
        async set(change: Change) {
          const rows = rowsOf(table);
          const row = rows.get(keyOf(table, key));
          if (!row) {
            throw new Error(`No existing record for ${keyOf(table, key)}`);
          }
          const updated = apply(row, change);
          rows.set(keyOf(table, key), updated);
          return updated;
        },
      };
    },
    async delete(table: object, key: Row) {
      return rowsOf(table).delete(keyOf(table, key));
    },
  };
  return {
    db,
    /** Every row of a table, in insertion order. */
    rows: (table: object) => [...rowsOf(table).values()],
  };
}
