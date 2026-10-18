import { customType } from "drizzle-orm/pg-core";

/** Postgres `ltree` column (requires the `ltree` extension). */
export const ltree = customType<{ data: string }>({
  dataType() {
    return "ltree";
  },
});
