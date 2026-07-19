#!/bin/sh
set -eu

# PostgreSQL executes this file only when its data directory is initialized.
# Application schema changes will be managed by versioned migrations in Phase 1.2.
echo "PostgreSQL initialization hook ready for database: ${POSTGRES_DB}"
