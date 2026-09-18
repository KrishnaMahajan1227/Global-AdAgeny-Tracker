-- Normalize historical work-item dimensions and areas to feet / sq.ft.
-- New writes already normalize in application code; this repairs existing rows.
CREATE OR REPLACE FUNCTION public._adroute_length_to_ft(v numeric, u text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lower(trim(coalesce(u,'ft')))
    WHEN 'in' THEN v/12.0 WHEN 'inch' THEN v/12.0 WHEN 'inches' THEN v/12.0
    WHEN 'm' THEN v*3.280839895013123 WHEN 'meter' THEN v*3.280839895013123 WHEN 'metre' THEN v*3.280839895013123
    WHEN 'cm' THEN v*0.03280839895013123 WHEN 'mm' THEN v*0.003280839895013123
    ELSE v END
$$;

UPDATE public.work_items SET
  survey_width = round(public._adroute_length_to_ft(survey_width, survey_unit), 4),
  survey_height = round(public._adroute_length_to_ft(survey_height, survey_unit), 4),
  survey_area = CASE WHEN survey_width IS NOT NULL AND survey_height IS NOT NULL THEN round(public._adroute_length_to_ft(survey_width,survey_unit) * public._adroute_length_to_ft(survey_height,survey_unit) * greatest(coalesce(survey_quantity,1),1), 2) ELSE survey_area END,
  survey_unit = CASE WHEN survey_width IS NOT NULL OR survey_height IS NOT NULL THEN 'ft' ELSE survey_unit END,
  approved_width = round(public._adroute_length_to_ft(approved_width, approved_unit), 4),
  approved_height = round(public._adroute_length_to_ft(approved_height, approved_unit), 4),
  approved_area = CASE WHEN approved_width IS NOT NULL AND approved_height IS NOT NULL THEN round(public._adroute_length_to_ft(approved_width,approved_unit) * public._adroute_length_to_ft(approved_height,approved_unit) * greatest(coalesce(approved_quantity,1),1), 2) ELSE approved_area END,
  approved_unit = CASE WHEN approved_width IS NOT NULL OR approved_height IS NOT NULL THEN 'ft' ELSE approved_unit END,
  installed_width = round(public._adroute_length_to_ft(installed_width, installed_unit), 4),
  installed_height = round(public._adroute_length_to_ft(installed_height, installed_unit), 4),
  installed_area = CASE WHEN installed_width IS NOT NULL AND installed_height IS NOT NULL THEN round(public._adroute_length_to_ft(installed_width,installed_unit) * public._adroute_length_to_ft(installed_height,installed_unit) * greatest(coalesce(installed_quantity,1),1), 2) ELSE installed_area END,
  installed_unit = CASE WHEN installed_width IS NOT NULL OR installed_height IS NOT NULL THEN 'ft' ELSE installed_unit END
WHERE coalesce(lower(survey_unit),'ft') <> 'ft' OR coalesce(lower(approved_unit),'ft') <> 'ft' OR coalesce(lower(installed_unit),'ft') <> 'ft';

DROP FUNCTION public._adroute_length_to_ft(numeric,text);
