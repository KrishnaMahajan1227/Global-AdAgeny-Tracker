# Installation review evidence update
- Owner/Admin Installation Review is now Work Item centric: Survey -> Measurement -> Approved Design -> Installed Proof.
- Installation proof photos are matched by work_item_id; legacy unmapped photos are clearly separated.
- Client-facing installation grids preserve landscape 4:3 instead of square cropping.
- Excel Installation Photos sheet now includes Work Item, Measurement and Approved Area (sq.ft) for each proof.
- Installation PDF/final client PDF captions include mapped Work Item + measurement.
- Final installation PPT labels the selected proof with mapped Work Item + measurement.
- Shop Details already fetches installation_jobs with installation_proofs and renders them under the exact Work Item.
