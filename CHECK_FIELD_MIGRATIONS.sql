-- READ ONLY. Run only if diagnosing field_corrections HTTP 400 in Supabase SQL Editor.
-- No data/DDL changes, reset, drop, or updates.
SELECT to_regclass('public.field_corrections') AS field_corrections_table,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='field_corrections'
           AND column_name='replacement_saved_at'
       ) AS redo_ack_column_from_migration_0091,
       to_regprocedure('public.field_redo_save(uuid,jsonb)') AS field_redo_save_rpc,
       to_regprocedure('public.review_submit_corrections(text,uuid)') AS correction_submit_rpc;
