import path from "node:path";
import process from "node:process";
import {
  createDuckDB,
  NODE_RUNTIME,
  ConsoleLogger,
  LogLevel,
} from "@duckdb/duckdb-wasm/blocking";

/**
 * Boots an in-memory DuckDB instance via the node-blocking bundle and returns
 * a connection wrapper compatible with the schema/migration code shipped in
 * `src/services/db`. The wrapper exposes an async-looking `query(sql)` method
 * and a `close()` to release resources.
 */
export async function createTestConnection() {
  const distDir = path.join(
    process.cwd(),
    "node_modules/@duckdb/duckdb-wasm/dist",
  );

  const bundle = {
    mvp: {
      mainModule: path.join(distDir, "duckdb-mvp.wasm"),
      mainWorker: path.join(distDir, "duckdb-node-mvp.worker.cjs"),
    },
  };

  const logger = new ConsoleLogger(LogLevel.WARNING);
  const bindings = await createDuckDB(bundle, logger, NODE_RUNTIME);
  await bindings.instantiate(() => null);
  const rawConn = bindings.connect();

  const conn = {
    query(sql) {
      // Match the duckdb-wasm async API used by the production code: a
      // thenable that resolves to an Apache Arrow Table with `.toArray()`.
      return Promise.resolve(rawConn.query(sql));
    },
    prepare(sql) {
      const rawStmt = rawConn.prepare(sql);
      return Promise.resolve({
        query: (...params) => Promise.resolve(rawStmt.query(...params)),
        close: () => {
          rawStmt.close();
          return Promise.resolve();
        },
      });
    },
    // Arquivo virtual, como o `registerFileText` da conexão de produção —
    // é por onde a restauração rápida entrega o JSON de cada tabela.
    registerFileText(name, text) {
      bindings.registerFileText(name, text);
    },
    dropFile(name) {
      bindings.dropFile(name);
    },
    close() {
      rawConn.close();
      bindings.terminate?.();
    },
  };

  return conn;
}
