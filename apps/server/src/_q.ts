import { openDb } from './db/client.ts';
const db = await openDb(undefined, process.argv[2]!);
for (const q of process.argv.slice(3)) console.log(q.slice(0, 60), JSON.stringify((await db.query(q)).rows, null, 0).slice(0, 3000));
await db.close();
