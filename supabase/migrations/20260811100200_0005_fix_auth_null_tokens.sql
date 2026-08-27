/*
# Repair seeded auth.users rows

The original seed migration only set confirmation_token/recovery_token,
leaving other text columns NULL. GoTrue (Supabase Auth) fails to scan a
NULL value into these Go string fields during login, surfacing as a
generic 500 "Database error querying schema". This migration patches any
existing rows that already have the problem, in addition to the seed
migration itself now inserting the correct values for future resets.
*/

UPDATE auth.users
SET
  confirmation_token         = COALESCE(confirmation_token, ''),
  recovery_token              = COALESCE(recovery_token, ''),
  email_change                 = COALESCE(email_change, ''),
  email_change_token_new       = COALESCE(email_change_token_new, ''),
  email_change_token_current   = COALESCE(email_change_token_current, ''),
  phone_change                 = COALESCE(phone_change, ''),
  phone_change_token           = COALESCE(phone_change_token, ''),
  reauthentication_token       = COALESCE(reauthentication_token, '')
WHERE
  confirmation_token IS NULL OR
  recovery_token IS NULL OR
  email_change IS NULL OR
  email_change_token_new IS NULL OR
  email_change_token_current IS NULL OR
  phone_change IS NULL OR
  phone_change_token IS NULL OR
  reauthentication_token IS NULL;
