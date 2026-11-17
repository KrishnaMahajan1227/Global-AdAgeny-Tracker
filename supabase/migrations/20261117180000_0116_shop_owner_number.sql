-- Separate owner mobile from contact-person phone without altering historical records.
-- Existing shops.contact_phone is the contact-person number.
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS owner_phone text;
COMMENT ON COLUMN public.shops.owner_phone IS 'Optional shop owner phone for 10-field new-shop creation; distinct from contact_phone (contact person number).';
