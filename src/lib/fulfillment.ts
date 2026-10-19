/** Phase 1: centralized, business-friendly fulfillment presets.
 * Keep legacy custom records readable; do not expose Custom for new orders.
 * Artwork origin is a DESIGN TASK choice, never another fulfillment type.
 */
import type { FulfillmentType } from './types';
import type { StageRequirements, OperationalMilestone } from './workCompletion';

export type StandardFulfillment = Exclude<FulfillmentType, 'custom'>;
export const FULFILLMENT_PRESETS: Array<{
  value: StandardFulfillment;
  label: string;
  description: string;
  steps: readonly string[];
  requirements: Readonly<Required<StageRequirements>>;
}> = [
  {
    value: 'survey_install', label: 'Survey & Installation',
    description: 'Field survey, artwork review, fabrication and installation.',
    steps: ['Survey', 'Design / artwork review', 'Production', 'Dispatch', 'Installation & review'],
    requirements: {requires_survey:true,requires_design:true,requires_production:true,requires_installation:true},
  },
  {
    value: 'production_install', label: 'Production & Installation',
    description: 'Use approved dimensions; no survey assignment. Artwork may be supplied by the company or prepared in-house.',
    steps: ['Design / artwork review', 'Production', 'Dispatch', 'Installation & review'],
    requirements: {requires_survey:false,requires_design:true,requires_production:true,requires_installation:true},
  },
  {
    value: 'supply_only', label: 'Production & Delivery',
    description: 'Produce, pack and dispatch. Survey and installer assignment are not required.',
    steps: ['Design / artwork review', 'Production', 'Dispatch / delivery'],
    requirements: {requires_survey:false,requires_design:true,requires_production:true,requires_installation:false},
  },
  {
    value: 'direct_install', label: 'On-site Execution',
    description: 'Field team completes wall painting or direct branding and submits location, measurements and photos.',
    steps: ['Assign field team', 'On-site execution', 'Installation review'],
    requirements: {requires_survey:false,requires_design:false,requires_production:false,requires_installation:true},
  },
];

export const historicalFulfillmentOption = {value:'custom', label:'Legacy custom scope', description:'Existing orders retain their own PO line requirements.'} as const;
export function fulfillmentPreset(value: string | null | undefined) { return FULFILLMENT_PRESETS.find(option => option.value === value); }
export function fulfillmentOptions(current?: string | null) {
  return current === 'custom' ? [...FULFILLMENT_PRESETS, historicalFulfillmentOption] : [...FULFILLMENT_PRESETS];
}
export function requiredMilestones(type:string | null | undefined): OperationalMilestone[] {
  switch(type) {
    case 'production_install': return ['design','production','dispatch','installation'];
    case 'supply_only': return ['design','production','dispatch'];
    case 'direct_install': return ['installation'];
    default: return ['survey','design','production','dispatch','installation'];
  }
}
