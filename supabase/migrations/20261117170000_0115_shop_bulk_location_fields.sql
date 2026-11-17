-- Universal Shop Bulk Upload: Taluka and PIN/Postal Code remain distinct optional fields.
-- Client-specific extra Excel headers are stored in existing shops.extra_details JSONB
-- (migration 0054), not as unbounded SQL columns. No data is deleted.
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS taluka text;
ALTER TABLE public.shops ADD COLUMN IF NOT EXISTS pincode text;
COMMENT ON COLUMN public.shops.taluka IS 'Optional taluka/tehsil; separate from district.';
COMMENT ON COLUMN public.shops.pincode IS 'Optional postal/PIN code saved as text to preserve leading zeroes.';
