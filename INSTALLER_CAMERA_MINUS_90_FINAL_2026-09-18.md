# Installer camera -90 degree final update

- Camera portrait-sensor normalization now rotates captured pixels -90 degrees (counter-clockwise) in `src/components/CameraCapture.tsx`.
- Geo-stamp landscape normalization uses the same -90 degree direction in `src/lib/geoStamp.ts` so camera capture and stamped output stay consistent.
- Already-landscape frames remain at 0 degrees.
- Existing 4:3 landscape canvas, no-center-crop contain behavior, geo-tag, Work Item mapping, resume, delete, bulk gallery, review and rejection cleanup remain unchanged.
