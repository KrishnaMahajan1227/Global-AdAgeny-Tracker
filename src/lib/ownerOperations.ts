/** A single stage-to-status mapping for stage drill-downs.
 * Keep the Work Order's fulfillment requirements in context: a dispatched
 * supply-only shop is complete, while a dispatched installation shop is not.
 */
import { shopStage, type StageBucket, type StageRequirements } from './workCompletion';

export type OwnerStageFilter = StageBucket | 'field';
export const shopStatusValues = [
  'pending','assigned','survey_started','surveyed','approval_pending','approved',
  'design_pending','designing','design_ready','in_review','design_approved',
  'production_pending','in_production','production_ready','production_hold','production_done',
  'dispatched','delivered','installation_pending','installing','installation_review',
  'installed','billed','rejected','cancelled',
] as const;
export const ownerStageLabels: Record<string, string> = {
  field:'Field & survey',pending:'Not started',survey:'Survey / approval',
  design:'Design',production:'Production',dispatch:'Dispatched',
  installation:'Installing',review:'Installation review',complete:'Delivered',
  excluded:'Excluded',
};
export function isOwnerStage(value: string): value is OwnerStageFilter {
  return value === 'field' || Object.prototype.hasOwnProperty.call(ownerStageLabels,value);
}
export function stageMatches(bucket: StageBucket, filter: OwnerStageFilter): boolean {
  return filter === 'field' ? bucket === 'pending' || bucket === 'survey' : bucket === filter;
}
export function statusesForStage(filter: OwnerStageFilter, fulfillment: string | null | undefined, requirements: StageRequirements[] = []): string[] {
  return shopStatusValues.filter(status => stageMatches(shopStage(fulfillment, status, requirements), filter));
}
export function describeOrderNextStep(stages: Record<StageBucket,number>, awaitingAcceptance = false): {label:string;stage:OwnerStageFilter;kind:'attention'|'progress'|'done'} {
  if (awaitingAcceptance) return {label:'Accept / decline assignment',stage:'field',kind:'attention'};
  if (stages.review) return {label:`${stages.review} installation review pending`,stage:'review',kind:'attention'};
  if (stages.survey) return {label:`${stages.survey} survey / approval pending`,stage:'survey',kind:'attention'};
  if (stages.pending) return {label:`${stages.pending} sites not started`,stage:'pending',kind:'attention'};
  if (stages.design) return {label:`${stages.design} in design`,stage:'design',kind:'progress'};
  if (stages.production) return {label:`${stages.production} in production`,stage:'production',kind:'progress'};
  if (stages.installation) return {label:`${stages.installation} installing`,stage:'installation',kind:'progress'};
  if (stages.dispatch) return {label:`${stages.dispatch} dispatched / awaiting installation`,stage:'dispatch',kind:'progress'};
  if (stages.complete) return {label:'All recorded sites delivered',stage:'complete',kind:'done'};
  return {label:'No linked site stages — check scope',stage:'field',kind:'attention'};
}
