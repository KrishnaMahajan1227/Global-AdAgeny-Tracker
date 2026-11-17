# AdRoute flexible shop upload + geo-tag QA

Date: 2026-11-17

| Area | Verification | Result |
|---|---|---|
| Shared importer | FMM/FSM Name accepted + auto-saved in extra_details | PASS (mocked) |
| Shared importer | All 11 columns, aliases, optional fields, required name/address | PASS |
| Shared importer | Header duplicates, unsafe names rejected; scope IDs protected | PASS |
| Shared importer | 500 shop rows preserve PO, project, zone, owner/contact identity | PASS (mocked) |
| Import dialogs | Agency, Client Shops and Client PO auto-keep extras and share template | PASS (source) |
| Reports | Additional data in agency/client Excel, UI field views preserved | PASS (source) |
| Geotag | Live camera metadata distinct from gallery/native import | PASS (source) |
| Geo renderer | Name, address, coordinate, timestamp text drawn in real canvas | PASS (mock canvas) |
| Geo renderer | Actual tile path, centered pin, attribution, missing GPS fallback | PASS (mock canvas) |
| Survey/Install | Survey, normal installation, direct installation, correction, admin uploads wired | PASS (source) |
| Work Orders | 10 item regression cases | PASS |
| Bulk | 30 historical mapping regression cases | PASS |
| Fulfillment | 19 cases | PASS |
| Dashboard | 10 cases | PASS |
| Security | 27 static + 16 phase 7 checks | PASS |
| TS/TSX | 128 files parse, 0 syntax errors; JSX symbols verified | PASS |
| Real GPS/photo on physical device | Phone permission, network tile-provider, EXIF behavior | NOT EXECUTED |
| Live Supabase/RLS, migrations | Staging migration + authoritative insert/permissions | NOT EXECUTED |
| Full dependency install / build / typecheck | Offline npm lacks required registry cache | NOT EXECUTED |
| Legacy broad release suite | 4 existing unrelated Campaign/deployment assertions | FAIL (prior baseline too) |

This QA matrix intentionally does not claim integration passes for systems not available in the current environment. See README_GEOTAG_FLEXIBLE_SHOPS_RELEASE.md for staging gates.
