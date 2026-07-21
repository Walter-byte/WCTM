CREATE TYPE "membership_role" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

ALTER TABLE "memberships"
  ALTER COLUMN "role" TYPE "membership_role"
  USING (UPPER("role")::"membership_role"),
  ALTER COLUMN "role" SET DEFAULT 'MEMBER';
