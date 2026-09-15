/*
# Phase C — Design traceability: source (client vs agency) (Section 5)

  ARCHITECTURE doc Section 5: a design either arrives from the client
  (source = 'client_provided') or is made in-house (source =
  'agency_designed'). Add this as an explicit column so Reports can show
  "% designs client-supplied vs agency-designed" and the workflow doesn't
  force an in-house designer step when the client already sent print-ready
  art — exactly the column the doc specifies, verbatim.

  Purely additive: existing rows default to 'agency_designed' (the only
  behaviour the app had until now), so nothing already uploaded changes
  meaning.
*/

ALTER TABLE public.design_versions
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'agency_designed'
    CHECK (source IN ('agency_designed','client_provided'));
