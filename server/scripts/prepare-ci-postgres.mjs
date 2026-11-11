#!/usr/bin/env node
/** Prepare only the disposable GitHub Actions PostgreSQL database for server tests. */
import postgres from 'postgres';

const databaseUrl = (process.env.DATABASE_URL || '').trim();
if (process.env.CI !== 'true' || !/^postgres(?:ql)?:\/\//u.test(databaseUrl)) {
  throw new Error('Refusing test-schema setup outside CI with a PostgreSQL DATABASE_URL.');
}

const db = postgres(databaseUrl, { max: 1, prepare: false, connect_timeout: 10 });
try {
  const result = await db`SELECT current_database() AS database_name, version()`;
  if (result[0]?.database_name !== 'nexus_test') {
    throw new Error(`Refusing to initialize unexpected database: ${result[0]?.database_name}`);
  }
  console.log(`CI test database: ${result[0].database_name}`);
  console.log(`PostgreSQL: ${result[0].version}`);
  // The pgvector service image supplies the extension files; tests need the
  // extension types/operators present before Drizzle pushes the canonical schema.
  await db.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
  await db.unsafe('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  console.log('PostgreSQL test extensions ready: vector, uuid-ossp');
} finally {
  await db.end({ timeout: 5 });
}
