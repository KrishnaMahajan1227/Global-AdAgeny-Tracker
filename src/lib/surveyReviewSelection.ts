/**
 * Survey review selection model.
 *
 * A marked photo and its work item are ONE selection in the review UI, while
 * the server still stores decisions on distinct measurement and photo entities.
 * A shared photo is only included when ALL of its related items will have the
 * same decision. This prevents partial review of one board accidentally
 * sending other boards on the same image for redo.
 */
export type SurveyReviewDecision = 'approved' | 'redo';
export type SurveyCorrectionScope = 'both' | 'measurement' | 'photo';
export type SurveyReviewTarget = { type: 'measurement' | 'survey_photo'; id: string };
export type SurveyReviewChoice = SurveyReviewTarget & { key: string };
export type SurveyReviewDecisionRecord = { entity_type: string; entity_id: string; decision: string };
export type SurveyReviewMarkingRef = { survey_photo_id: string; work_item_id?: string | null };
export type SurveyReviewPhotoLink = { survey_photo_id: string; work_item_id: string };

export function surveyReviewSelectionModel(args: {
  items: { id: string }[];
  photos: { id: string }[];
  markings: SurveyReviewMarkingRef[];
  links: SurveyReviewPhotoLink[];
  decisions: SurveyReviewDecisionRecord[];
}) {
  const { items, photos, markings, links, decisions } = args;
  const itemIds = new Set(items.map(item => item.id));
  const decisionsByKey = new Map(decisions.map(d => [`${d.entity_type}:${d.entity_id}`, d.decision]));
  const photoItemIds = new Map<string, Set<string>>(photos.map(p => [p.id, new Set<string>()]));
  for (const ref of [...markings, ...links]) {
    if (ref.work_item_id && itemIds.has(ref.work_item_id)) photoItemIds.get(ref.survey_photo_id)?.add(ref.work_item_id);
  }

  const choices: SurveyReviewChoice[] = items
    .filter(item => !decisionsByKey.has(`measurement:${item.id}`))
    .map(item => ({ key: `measurement:${item.id}`, type: 'measurement' as const, id: item.id }));

  // Linked images aren't a second review checkbox. Exception: a photo can
  // still need a decision when all linked measurements were decided earlier.
  for (const photo of photos) {
    const linked = photoItemIds.get(photo.id) || new Set<string>();
    if (decisionsByKey.has(`survey_photo:${photo.id}`)) continue;
    if (!linked.size || [...linked].every(itemId => decisionsByKey.has(`measurement:${itemId}`))) {
      choices.push({ key: `survey_photo:${photo.id}`, type: 'survey_photo', id: photo.id });
    }
  }

  function expand(selected: ReadonlySet<string>, decision: SurveyReviewDecision, scope: SurveyCorrectionScope = 'both', selectedPhotoId?: string): SurveyReviewTarget[] {
    const valid = new Set(choices.map(choice => choice.key));
    const chosen = new Set([...selected].filter(key => valid.has(key)));
    const targets: SurveyReviewTarget[] = [];
    for (const item of items) {
      if (scope !== 'photo' && chosen.has(`measurement:${item.id}`)) targets.push({ type: 'measurement', id: item.id });
    }
    for (const photo of photos) {
      const key = `survey_photo:${photo.id}`;
      if (scope === 'photo' && selectedPhotoId && selectedPhotoId !== 'all' && photo.id !== selectedPhotoId) continue;
      if (decisionsByKey.has(key)) continue;
      const linked = photoItemIds.get(photo.id) || new Set<string>();
      // Include a shared image only once every board linked to it is
      // receiving (or already received) the same action.
      const matching = [...linked].every(itemId =>
        chosen.has(`measurement:${itemId}`) || decisionsByKey.get(`measurement:${itemId}`) === decision,
      );
      const selectedRelated = [...linked].some(itemId => chosen.has(`measurement:${itemId}`));
      if (scope === 'measurement') continue;
      if (!chosen.has(key) && !selectedRelated) continue;
      // Rejecting a shared photo changes the entire photo: require ALL its
      // marked boards to be selected before changing photo-level evidence.
      // Measurement-only redo remains available for a single board.
      if (scope === 'photo' && linked.size > 1 && ![...linked].every(itemId => chosen.has(`measurement:${itemId}`))) {
        throw new Error('This photo contains multiple work items. Select every linked item before requesting photo-only redo, or choose Measurement only.');
      }
      if (chosen.has(key) || matching) targets.push({ type: 'survey_photo', id: photo.id });
    }
    return targets;
  }
  return { choices, photoItemIds, decisionsByKey, expand };
}
