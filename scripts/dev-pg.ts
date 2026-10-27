// Dev helper: serve a throw-away in-memory Postgres (PGlite) on 127.0.0.1:5544 for local smoke tests.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 5544, host: "127.0.0.1" });
await server.start();
console.log("ready");
process.on("SIGTERM", async () => { await server.stop(); await db.close(); process.exit(0); });
