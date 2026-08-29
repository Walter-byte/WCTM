DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "users"
    GROUP BY lower(btrim("email"))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Public authentication migration refused: normalized User email collision exists';
  END IF;
END $$;

ALTER TABLE "users" ADD COLUMN "password_hash" TEXT;
