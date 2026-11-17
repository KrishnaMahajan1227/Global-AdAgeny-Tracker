// Compatibility test entrypoint: base shop columns were expanded to include
// Contact Person, and customer-specific columns now auto-save to JSONB.
// The new suite checks the common columns AND extensible fields.
require('./verify-flexible-shops-geotag.cjs');
