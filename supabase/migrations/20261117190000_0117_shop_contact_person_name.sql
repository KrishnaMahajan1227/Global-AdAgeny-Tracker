-- Contact Person is not necessarily the shop owner. Keep both separately.
-- Existing shop records remain unchanged; null is valid for historical rows.
ALTER TABLE public.shops
  ADD COLUMN IF NOT EXISTS contact_person_name text;
COMMENT ON COLUMN public.shops.contact_person_name IS
  'Name of on-site contact person, distinct from the shop owner and the contact phone number.';
