# Installer accordion UX update

- Approved work items are now compact accordion rows.
- Tapping a work item expands its approved size/quantity/sq.ft, its mapped survey reference photo(s), and photo actions.
- `Take Photo` opens the camera already mapped to that exact work item; no second work-item selector is shown.
- `Gallery` is inside the expanded work item and supports multiple files, all automatically mapped to that item.
- Installer location-status card was removed from the job UI; location tracking can continue in the background for operational/admin use.
- Installation proof thumbnails are summarized below the work items and can be removed before submission.
- After adding proof, installer can go directly to Review Installation and Final Submit; review Back returns to the shop/work-item screen.
- Existing survey-photo mapping uses survey_photo_items with board_markings fallback for older deployments.
