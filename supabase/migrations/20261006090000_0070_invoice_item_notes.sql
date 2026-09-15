/*
# Per-line-item notes on invoices

Invoices already had one whole-invoice `notes` field, but nothing at the
line-item level — no way to record something like "excluded 3 shops from
this line item, client said no branding needed there after survey" right
next to the specific line it applies to. That kind of exception is common
enough (a client's post-survey approval routinely drops a few shops from
a line item's scope) that it needs to live with the item, not buried in
one shared invoice-wide notes box.

Purely additive: nullable text column, existing rows unaffected.
*/

ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS notes text;

COMMENT ON COLUMN public.invoice_items.notes IS
  'Internal note for this specific line item — e.g. shops excluded after client review, partial-quantity explanation. Not printed on the client-facing invoice PDF.';
