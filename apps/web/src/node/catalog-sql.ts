/** SQL plans keep conflict checks and RETURNING rows explicit for transactional execution. */
export type CatalogSqlBinding =
  | { kind: "input"; index: number }
  | { kind: "candidate"; column: string };
export type CatalogSqlFragment = { sql: string; bindings: CatalogSqlBinding[] };
export type CatalogSqlAssignment = {
  column: string;
  expression: CatalogSqlFragment;
};
export type CatalogSqlPlan =
  | { kind: "query"; statement: CatalogSqlFragment }
  | {
      kind: "insert";
      table: string;
      columns: string[];
      source: CatalogSqlFragment;
      conflict?: {
        target?: string[];
        action: "nothing" | "update";
        assignments?: CatalogSqlAssignment[];
        where?: CatalogSqlFragment;
      };
      returning?: CatalogSqlFragment;
    }
  | {
      kind: "update";
      table: string;
      selection: CatalogSqlFragment;
      assignments: CatalogSqlAssignment[];
      returning?: CatalogSqlFragment;
    }
  | {
      kind: "delete";
      table: string;
      selection: CatalogSqlFragment;
      returning?: CatalogSqlFragment;
    };

type Token = {
  kind: "word" | "identifier" | "literal" | "number" | "symbol" | "parameter";
  text: string;
  index?: number;
};
const keywords = new Set(
  "SELECT DISTINCT FROM WHERE AND OR NOT NULL IS IN EXISTS BETWEEN LIKE ESCAPE AS JOIN INNER LEFT RIGHT OUTER CROSS ON USING GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET CASE WHEN THEN ELSE END UNION ALL TRUE FALSE FOR UPDATE DEFAULT".split(
    " ",
  ),
);
const functions = new Set(
  "COUNT SUM AVG MIN MAX COALESCE LOWER UPPER LENGTH CHAR_LENGTH SUBSTR SUBSTRING REPLACE TRIM LTRIM RTRIM ABS ROUND IFNULL NULLIF INSTR HEX".split(
    " ",
  ),
);
function identifier(value: string) {
  return `\`${value.replaceAll("`", "``")}\``;
}
function word(token: Token | undefined, value: string) {
  return token?.kind === "word" && token.text.toUpperCase() === value;
}
function tokenize(sql: string): Token[] {
  const result: Token[] = [];
  let offset = 0;
  let parameter = 0;
  while (offset < sql.length) {
    const start = offset;
    const char = sql[offset];
    if (/\s/u.test(char)) {
      offset++;
      continue;
    }
    if (sql.startsWith("--", offset)) {
      const end = sql.indexOf("\n", offset);
      offset = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", offset)) {
      const end = sql.indexOf("*/", offset + 2);
      if (end < 0) throw new Error("Unterminated SQL comment");
      offset = end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      let value = "";
      offset++;
      let ended = false;
      while (offset < sql.length) {
        const next = sql[offset++];
        if (next === close) {
          if (sql[offset] === close) {
            value += close;
            offset++;
          } else {
            ended = true;
            break;
          }
        } else value += next;
      }
      if (!ended) throw new Error("Unterminated SQL quotation");
      result.push({
        kind: char === "'" ? "literal" : "identifier",
        text: value,
      });
      continue;
    }
    if (char === "?") {
      result.push({ kind: "parameter", text: "?", index: parameter++ });
      offset++;
      continue;
    }
    if (/[A-Za-z_]/u.test(char)) {
      while (offset < sql.length && /[A-Za-z_0-9$]/u.test(sql[offset]))
        offset++;
      result.push({ kind: "word", text: sql.slice(start, offset) });
      continue;
    }
    if (/[0-9]/u.test(char)) {
      while (offset < sql.length && /[0-9.]/u.test(sql[offset])) offset++;
      result.push({ kind: "number", text: sql.slice(start, offset) });
      continue;
    }
    const operator = ["<>", "!=", "<=", ">=", "||", "=="].find((value) =>
      sql.startsWith(value, offset),
    );
    if (operator) {
      result.push({ kind: "symbol", text: operator });
      offset += operator.length;
      continue;
    }
    if ("(),.*+-/%=<>;&|".includes(char)) {
      result.push({ kind: "symbol", text: char });
      offset++;
      continue;
    }
    throw new Error(`Unsupported SQL token at position ${offset}`);
  }
  if (result.at(-1)?.text === ";") result.pop();
  if (result.some((token) => token.text === ";" && token.kind === "symbol"))
    throw new Error("Multiple SQL statements are not permitted");
  return result;
}
function closing(tokens: Token[], start: number) {
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].kind === "symbol" && tokens[index].text === "(") depth++;
    if (
      tokens[index].kind === "symbol" &&
      tokens[index].text === ")" &&
      --depth === 0
    )
      return index;
  }
  throw new Error("Unbalanced SQL parentheses");
}
function topIndex(
  tokens: Token[],
  predicate: (token: Token, index: number) => boolean,
  start = 0,
) {
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index];
    if (depth === 0 && predicate(token, index)) return index;
    if (token.kind === "symbol" && token.text === "(") depth++;
    if (token.kind === "symbol" && token.text === ")") depth--;
    if (depth < 0) throw new Error("Unbalanced SQL parentheses");
  }
  if (depth !== 0) throw new Error("Unbalanced SQL parentheses");
  return -1;
}
function split(tokens: Token[], separator = ",") {
  const result: Token[][] = [];
  let start = 0;
  for (;;) {
    const index = topIndex(
      tokens,
      (token) => token.kind === "symbol" && token.text === separator,
      start,
    );
    if (index < 0) {
      result.push(tokens.slice(start));
      return result;
    }
    result.push(tokens.slice(start, index));
    start = index + 1;
  }
}
function name(token: Token | undefined) {
  if (!token || !["identifier", "word"].includes(token.kind))
    throw new Error("An SQL identifier is required");
  return token.text;
}
function combine(parts: (string | CatalogSqlFragment)[]): CatalogSqlFragment {
  return {
    sql: parts
      .map((part) => (typeof part === "string" ? part : part.sql))
      .join(""),
    bindings: parts.flatMap((part) =>
      typeof part === "string" ? [] : part.bindings,
    ),
  };
}
function asciiFold(fragment: CatalogSqlFragment, binary = true) {
  let result = fragment;
  for (let code = 65; code <= 90; code++)
    result = combine([
      "REPLACE(",
      result,
      `, '${String.fromCharCode(code)}', '${String.fromCharCode(code + 32)}')`,
    ]);
  return binary
    ? combine(["BINARY ", result])
    : combine(["(", result, ") COLLATE utf8mb4_0900_bin"]);
}
function atomEnd(tokens: Token[], start: number) {
  const token = tokens[start];
  if (!token) return start;
  if (token.kind === "symbol" && token.text === "(")
    return closing(tokens, start) + 1;
  if (["word", "identifier"].includes(token.kind)) {
    if (tokens[start + 1]?.text === "(") return closing(tokens, start + 1) + 1;
    if (tokens[start + 1]?.text === ".") return start + 3;
  }
  return start + 1;
}
function render(tokens: Token[], candidates = false): CatalogSqlFragment {
  const parts: (string | CatalogSqlFragment)[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const upper = token.text.toUpperCase();
    if (index) parts.push(" ");
    if (
      word(token, "IN") &&
      tokens[index + 1]?.text === "(" &&
      word(tokens[index + 2], "SELECT")
    ) {
      const end = closing(tokens, index + 1);
      const subquery = tokens.slice(index + 2, end);
      if (topIndex(subquery, (value) => word(value, "LIMIT")) >= 0) {
        parts.push(
          "IN (SELECT * FROM (",
          render(subquery, candidates),
          `) AS ${identifier(`__hl_limited_${index}`)})`,
        );
        index = end;
        continue;
      }
    }
    if (
      (word(token, "FROM") || word(token, "JOIN")) &&
      tokens[index + 1]?.text === "("
    ) {
      const end = closing(tokens, index + 1);
      parts.push(
        upper,
        " (",
        render(tokens.slice(index + 2, end), candidates),
        ")",
      );
      const after = tokens[end + 1];
      if (
        !after ||
        (after.kind === "word" &&
          keywords.has(after.text.toUpperCase()) &&
          !word(after, "AS")) ||
        after.text === ")"
      )
        parts.push(` AS ${identifier(`__hl_derived_${index}`)}`);
      index = end;
      continue;
    }
    const firstEnd = atomEnd(tokens, index);
    const likeAt = word(tokens[firstEnd], "NOT") ? firstEnd + 1 : firstEnd;
    if (word(tokens[likeAt], "LIKE")) {
      const rhsEnd = atomEnd(tokens, likeAt + 1);
      if (word(tokens[rhsEnd], "ESCAPE"))
        throw new Error("Explicit LIKE escaping requires a native operation");
      parts.push(
        asciiFold(render(tokens.slice(index, firstEnd), candidates), false),
        likeAt !== firstEnd ? " NOT LIKE " : " LIKE ",
        asciiFold(render(tokens.slice(likeAt + 1, rhsEnd), candidates), false),
        " ESCAPE ''",
      );
      index = rhsEnd - 1;
      continue;
    }
    if (tokens[firstEnd]?.text === "||") {
      const values: CatalogSqlFragment[] = [
        render(tokens.slice(index, firstEnd), candidates),
      ];
      let end = firstEnd;
      while (tokens[end]?.text === "||") {
        const nextEnd = atomEnd(tokens, end + 1);
        if (nextEnd === end + 1)
          throw new Error("Missing concatenation operand");
        values.push(render(tokens.slice(end + 1, nextEnd), candidates));
        end = nextEnd;
      }
      parts.push(
        "CONCAT(",
        combine(
          values.flatMap((value, valueIndex) => [
            ...(valueIndex ? [", "] : []),
            value,
          ]),
        ),
        ")",
      );
      index = end - 1;
      continue;
    }
    // Current catalog NOCASE sites compare a column to a bound value. Fold ASCII only,
    // matching SQLite instead of applying a broader Unicode/accent MySQL collation.
    const lhsEnd = tokens[index + 1]?.text === "." ? index + 3 : index + 1;
    if (
      ["word", "identifier"].includes(token.kind) &&
      tokens[lhsEnd]?.text === "=" &&
      tokens[lhsEnd + 1]?.kind === "parameter" &&
      word(tokens[lhsEnd + 2], "COLLATE") &&
      word(tokens[lhsEnd + 3], "NOCASE")
    ) {
      parts.push(
        asciiFold(render(tokens.slice(index, lhsEnd), candidates)),
        " = ",
        asciiFold(render([tokens[lhsEnd + 1]], candidates)),
      );
      index = lhsEnd + 3;
      continue;
    }
    if (word(token, "COLLATE"))
      throw new Error("Unsupported SQL collation expression");
    if (token.kind === "parameter") {
      parts.push({
        sql: "?",
        bindings: [{ kind: "input", index: token.index! }],
      });
      continue;
    }
    if (token.kind === "literal") {
      // Hex literals avoid dependence on the connection NO_BACKSLASH_ESCAPES mode.
      parts.push(
        `CONVERT(X'${Buffer.from(token.text).toString("hex")}' USING utf8mb4)`,
      );
      continue;
    }
    if (token.kind === "identifier") {
      parts.push(identifier(token.text));
      continue;
    }
    if (token.kind === "number") {
      parts.push(token.text);
      continue;
    }
    if (token.kind === "symbol") {
      if (token.text === "(" && word(tokens[index + 1], "WITH")) {
        const end = closing(tokens, index);
        parts.push("(", renderWith(tokens.slice(index + 1, end)), ")");
        index = end;
        continue;
      }
      if (token.text === "||")
        throw new Error(
          "SQLite concatenation requires an explicit native operation",
        );
      parts.push(token.text === "==" ? "=" : token.text);
      continue;
    }
    if (word(token, "IS") && tokens[index + 1]?.kind === "parameter") {
      parts.push("<=>");
      continue;
    }
    if (word(token, "EXCLUDED") && tokens[index + 1]?.text === ".") {
      if (!candidates)
        throw new Error("Excluded columns are only valid in a conflict action");
      parts.push({
        sql: "?",
        bindings: [{ kind: "candidate", column: name(tokens[index + 2]) }],
      });
      index += 2;
      continue;
    }
    if (tokens[index + 1]?.text === "(" && !keywords.has(upper)) {
      const end = closing(tokens, index + 1);
      const args = split(tokens.slice(index + 2, end));
      if (upper === "JSON_EACH") {
        if (args.length !== 1)
          throw new Error("json_each requires one argument");
        parts.push(
          combine([
            "JSON_TABLE(",
            render(args[0], candidates),
            ", '$[*]' COLUMNS (`value` JSON PATH '$')) AS `__hl_json_each`",
          ]),
        );
      } else if (upper === "JSON_EXTRACT") {
        if (
          args.length !== 2 ||
          args[1].length !== 1 ||
          args[1][0].kind !== "literal"
        )
          throw new Error("Only literal JSON paths are supported");
        const path = args[1][0].text;
        // These are the complete JSON paths used in the application catalog.
        if (
          ![
            "$.type",
            "$.id",
            "$.deploymentKind",
            "$.commit",
            "$.schema",
          ].includes(path)
        )
          throw new Error(`Unsupported catalog JSON path: ${path}`);
        const value = combine([
          "JSON_EXTRACT(",
          render(args[0], candidates),
          `, '${path}')`,
        ]);
        parts.push(
          combine([
            "CASE WHEN JSON_TYPE(",
            value,
            ") = 'NULL' THEN NULL ELSE ",
            path === "$.schema" ? "CAST(JSON_UNQUOTE(" : "JSON_UNQUOTE(",
            value,
            path === "$.schema" ? ") AS UNSIGNED)" : ")",
            " END",
          ]),
        );
      } else {
        if (!functions.has(upper))
          throw new Error(`Unsupported SQL function: ${token.text}`);
        const fn =
          (upper === "MAX" || upper === "MIN") && args.length > 1
            ? upper === "MAX"
              ? "GREATEST"
              : "LEAST"
            : upper === "LENGTH"
              ? "CHAR_LENGTH"
              : upper;
        parts.push(
          fn,
          "(",
          combine(
            args.flatMap((arg, argIndex) => [
              ...(argIndex ? [", "] : []),
              render(arg, candidates),
            ]),
          ),
          ")",
        );
      }
      index = end;
      continue;
    }
    parts.push(keywords.has(upper) ? upper : identifier(token.text));
  }
  return combine(parts);
}
function assignments(tokens: Token[], candidates = false) {
  return split(tokens).map((assignment) => {
    const equal = topIndex(assignment, (token) => token.text === "=");
    if (equal !== 1)
      throw new Error("Only direct column assignments are supported");
    if (assignment.length <= 2)
      throw new Error("Assignment expression is missing");
    return {
      column: name(assignment[0]),
      expression: render(assignment.slice(2), candidates),
    };
  });
}
function returningPart(tokens: Token[]) {
  const index = topIndex(tokens, (token) => word(token, "RETURNING"));
  return {
    body: index < 0 ? tokens : tokens.slice(0, index),
    returning: index < 0 ? undefined : render(tokens.slice(index + 1)),
  };
}
function sourceSelect(tokens: Token[], columns: string[]): CatalogSqlFragment {
  if (word(tokens[0], "VALUES")) {
    const rows = split(tokens.slice(1));
    return combine(
      rows.flatMap((row, rowIndex) => {
        if (row[0]?.text !== "(" || closing(row, 0) !== row.length - 1)
          throw new Error("Invalid INSERT VALUES row");
        const values = split(row.slice(1, -1));
        if (values.length !== columns.length)
          throw new Error("INSERT column and value counts differ");
        return [
          ...(rowIndex ? [" UNION ALL "] : []),
          "SELECT ",
          combine(
            values.flatMap((value, index) => [
              ...(index ? [", "] : []),
              render(value),
              ` AS ${identifier(`__hl_insert_${index}`)}`,
            ]),
          ),
        ];
      }),
    );
  }
  if (!word(tokens[0], "SELECT"))
    throw new Error("INSERT requires VALUES or SELECT");
  const tail = topIndex(
    tokens,
    (token) =>
      ["FROM", "WHERE", "ORDER", "LIMIT", "GROUP", "HAVING", "UNION"].some(
        (keyword) => word(token, keyword),
      ),
    1,
  );
  const projection = split(tokens.slice(1, tail < 0 ? tokens.length : tail));
  if (projection.length !== columns.length)
    throw new Error("INSERT SELECT column counts differ");
  return combine([
    "SELECT ",
    combine(
      projection.flatMap((value, index) => [
        ...(index ? [", "] : []),
        render(value),
        ` AS ${identifier(`__hl_insert_${index}`)}`,
      ]),
    ),
    tail < 0 ? "" : combine([" ", render(tokens.slice(tail))]),
  ]);
}

function renderWith(tokens: Token[]): CatalogSqlFragment {
  let cursor = 1;
  const recursive = word(tokens[cursor], "RECURSIVE");
  if (recursive) cursor++;
  const ctes: CatalogSqlFragment[] = [];
  for (;;) {
    const cte = name(tokens[cursor++]);
    let columns: string[] = [];
    if (tokens[cursor]?.text === "(") {
      const end = closing(tokens, cursor);
      columns = split(tokens.slice(cursor + 1, end)).map((value) =>
        name(value[0]),
      );
      cursor = end + 1;
    }
    if (!word(tokens[cursor++], "AS") || tokens[cursor]?.text !== "(")
      throw new Error("Invalid common table expression");
    const end = closing(tokens, cursor);
    const body = tokens.slice(cursor + 1, end);
    if (!word(body[0], "SELECT"))
      throw new Error("Only SELECT common table expressions are supported");
    ctes.push(
      combine([
        identifier(cte),
        columns.length ? `(${columns.map(identifier).join(", ")})` : "",
        " AS (",
        render(body),
        ")",
      ]),
    );
    cursor = end + 1;
    if (tokens[cursor]?.text !== ",") break;
    cursor++;
  }
  if (!word(tokens[cursor], "SELECT"))
    throw new Error("WITH must end in SELECT");
  return combine([
    recursive ? "WITH RECURSIVE " : "WITH ",
    combine(ctes.flatMap((cte, index) => [...(index ? [", "] : []), cte])),
    " ",
    render(tokens.slice(cursor)),
  ]);
}

/** Compile the application's explicit SQL grammar. Unsupported SQL fails before execution. */
export function compileCatalogSql(sql: string): CatalogSqlPlan {
  const tokens = tokenize(sql);
  if (word(tokens[0], "WITH"))
    return { kind: "query", statement: renderWith(tokens) };
  if (word(tokens[0], "SELECT"))
    return { kind: "query", statement: render(tokens) };
  if (word(tokens[0], "INSERT")) {
    let cursor = 1;
    let ignore = false;
    if (word(tokens[cursor], "OR") && word(tokens[cursor + 1], "IGNORE")) {
      ignore = true;
      cursor += 2;
    }
    if (!word(tokens[cursor++], "INTO"))
      throw new Error("INSERT requires INTO");
    const table = name(tokens[cursor++]);
    if (tokens[cursor]?.text !== "(")
      throw new Error("INSERT requires explicit columns");
    const columnEnd = closing(tokens, cursor);
    const columns = split(tokens.slice(cursor + 1, columnEnd)).map((value) => {
      if (value.length !== 1) throw new Error("Invalid INSERT column");
      return name(value[0]);
    });
    cursor = columnEnd + 1;
    const { body, returning } = returningPart(tokens.slice(cursor));
    const conflictIndex = topIndex(
      body,
      (token, index) => word(token, "ON") && word(body[index + 1], "CONFLICT"),
    );
    let conflict: Extract<CatalogSqlPlan, { kind: "insert" }>["conflict"] =
      ignore ? { action: "nothing" } : undefined;
    if (conflictIndex >= 0) {
      const clause = body.slice(conflictIndex + 2);
      if (clause[0]?.text !== "(")
        throw new Error("ON CONFLICT requires an explicit conflict target");
      const end = closing(clause, 0);
      const target = split(clause.slice(1, end)).map((value) => {
        if (value.length !== 1) throw new Error("Invalid conflict target");
        return name(value[0]);
      });
      if (!word(clause[end + 1], "DO"))
        throw new Error("Invalid conflict action");
      if (word(clause[end + 2], "NOTHING") && clause.length === end + 3)
        conflict = { target, action: "nothing" };
      else if (
        word(clause[end + 2], "UPDATE") &&
        word(clause[end + 3], "SET")
      ) {
        const action = clause.slice(end + 4);
        const condition = topIndex(action, (token) => word(token, "WHERE"));
        conflict = {
          target,
          action: "update",
          assignments: assignments(
            condition < 0 ? action : action.slice(0, condition),
            true,
          ),
          where:
            condition < 0
              ? undefined
              : render(action.slice(condition + 1), true),
        };
      } else throw new Error("Unsupported conflict action");
    }
    return {
      kind: "insert",
      table,
      columns,
      source: sourceSelect(
        conflictIndex < 0 ? body : body.slice(0, conflictIndex),
        columns,
      ),
      conflict,
      returning,
    };
  }
  if (word(tokens[0], "UPDATE")) {
    const table = name(tokens[1]);
    if (!word(tokens[2], "SET")) throw new Error("UPDATE requires SET");
    const { body, returning } = returningPart(tokens.slice(3));
    const where = topIndex(body, (token) => word(token, "WHERE"));
    return {
      kind: "update",
      table,
      assignments: assignments(where < 0 ? body : body.slice(0, where)),
      selection: combine([
        `SELECT ${identifier(table)}.* FROM ${identifier(table)}`,
        where < 0 ? "" : combine([" ", render(body.slice(where))]),
        " FOR UPDATE",
      ]),
      returning,
    };
  }
  if (word(tokens[0], "DELETE") && word(tokens[1], "FROM")) {
    const table = name(tokens[2]);
    const { body, returning } = returningPart(tokens.slice(3));
    if (body.length && !word(body[0], "WHERE"))
      throw new Error("Unsupported DELETE clause");
    return {
      kind: "delete",
      table,
      selection: combine([
        `SELECT ${identifier(table)}.* FROM ${identifier(table)}`,
        body.length ? combine([" ", render(body)]) : "",
        " FOR UPDATE",
      ]),
      returning,
    };
  }
  throw new Error(
    "Only catalog SELECT, INSERT, UPDATE, and DELETE operations are supported",
  );
}
