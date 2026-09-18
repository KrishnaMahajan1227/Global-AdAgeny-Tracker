# Installer Camera Final Fix — 2026-09-18

- Fixed Work Item camera capture using an invalid `installed` value as the photo angle. Camera captures now use a valid `front` angle and remain mapped to the selected Work Item.
- Gallery upload behaviour remains unchanged and mapped.
- Removed pixel rotation from live camera landscape normalization. Portrait camera frames are center-cropped to a 4:3 landscape image instead of being rotated sideways.
- Updated shared `ensureLandscape` to use the same no-rotation landscape normalization before geo-tag stamping.
- Geo-tag stamping continues after landscape normalization.
