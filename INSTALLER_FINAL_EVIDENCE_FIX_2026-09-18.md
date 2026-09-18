# Installer final evidence fixes
- Live camera requests 4:3 landscape and saves a true 4:3 landscape JPEG.
- No centre crop / no pixel rotation: unexpected camera ratios are fitted inside 4:3 so the complete frame is retained.
- Geo tag is burned onto the landscape proof and therefore remains visible in downloads/prints.
- Existing uploaded installation proofs reload when an installer leaves a shop and returns; per-shop UI progress is also restored locally.
- Reject / Send for Redo now deletes that installation attempt's proof rows and storage objects, preventing rejected photos from being appended to the next attempt.
- Proof thumbnails use contain rendering to avoid UI cropping.
