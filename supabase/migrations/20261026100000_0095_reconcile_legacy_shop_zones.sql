-- Optional data repair: staging + backup first. Does not drop, truncate or
-- delete data. Fills only NULL zone_id for shops with a non-empty zone name.
-- Shops with blank Zone remain unassigned (shown as "No Zone").
DO $$
DECLARE
  candidate record;
  matched_zone_id uuid;
BEGIN
  FOR candidate IN
    SELECT DISTINCT organization_id, project_id, btrim(zone) AS zone_name
    FROM public.shops
    WHERE zone_id IS NULL AND zone IS NOT NULL AND btrim(zone) <> ''
  LOOP
    -- Scoped to the original organization and project. Reuse names only
    -- within the same scope, never across clients/organizations.
    SELECT id INTO matched_zone_id
      FROM public.zones
      WHERE organization_id = candidate.organization_id
        AND project_id IS NOT DISTINCT FROM candidate.project_id
        AND lower(btrim(name)) = lower(candidate.zone_name)
      ORDER BY created_at, id LIMIT 1;

    IF matched_zone_id IS NULL THEN
      INSERT INTO public.zones (organization_id, project_id, name)
      VALUES (candidate.organization_id, candidate.project_id, candidate.zone_name)
      ON CONFLICT DO NOTHING
      RETURNING id INTO matched_zone_id;
      IF matched_zone_id IS NULL THEN
        SELECT id INTO matched_zone_id FROM public.zones
          WHERE organization_id = candidate.organization_id
            AND project_id IS NOT DISTINCT FROM candidate.project_id
            AND lower(btrim(name)) = lower(candidate.zone_name)
          ORDER BY created_at, id LIMIT 1;
      END IF;
    END IF;

    IF matched_zone_id IS NOT NULL THEN
      UPDATE public.shops s SET zone_id = matched_zone_id
      WHERE s.organization_id = candidate.organization_id
        AND s.project_id IS NOT DISTINCT FROM candidate.project_id
        AND lower(btrim(s.zone)) = lower(candidate.zone_name)
        AND s.zone_id IS NULL;
    END IF;
  END LOOP;
END $$;
