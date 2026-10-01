-- Per-database extensions. Run by a superuser in every database that receives the migrations,
-- before the first migration. Not a migration: `CREATE EXTENSION vector` fails for
-- couli_migrator on the pgvector image ("must be superuser", ADR-0001 §7).
CREATE EXTENSION IF NOT EXISTS vector;
