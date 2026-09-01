import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { Drawer, StatusBadge, EmptyState, PageHeader, Textarea, Select } from '@/components/ui';
import { logAudit, createNotification } from '@/lib/helpers';
import { useRealtimeInvalidate } from '@/lib/useRealtimeInvalidate';
import { MarkedPhotoGrid } from '@/components/MarkedPhotoGrid';
import type { SurveyPhoto, BoardMarking, WorkItem, POLineItemWorkContext } from '@/lib/types';
import { computePOVariance } from '@/lib/poVariance';
import { CheckCircle2, XCircle, AlertCircle, FileText, ChevronRight, MapPin, StickyNote } from 'lucide-react';
import { Link } from 'react-router-dom';

type ReviewAction = 'approve' | 'reject' | 'correction';

export default function SurveyReviewPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const queryClient = useQueryClient();

  // The survey currently open in the review drawer. Opening it never
  // implies a decision — Admin/Owner sees every detail first, and only
  // picks approve/reject/correction inside the drawer once they've
  // actually looked. Previously the three list buttons pre-selected the
  // action AND opened the modal in one click, so the decision was made
  // before anything was visible — exactly backwards for a review step.
  const [selectedSurvey, setSelectedSurvey] = useState<any | null>(null);
  const [action, setAction] = useState<ReviewAction | null>(null);
  const [note, setNote] = useState('');
  const [designerId, setDesignerId] = useState('');
  // Section 8 — adjustment note per work item, keyed by work_item.id, only
  // filled in when Admin/Owner chooses to explain a variance (never
  // required — exceeding budget is allowed, just never silent). Reset
  // whenever a different survey's review drawer is opened.
  const [varianceNotes, setVarianceNotes] = useState<Record<string, string>>({});

  const isPendingSurvey = selectedSurvey?.status === 'submitted';

  const closeDrawer = () => {
    setSelectedSurvey(null);
    setAction(null);
    setNote('');
    setDesignerId('');
    setVarianceNotes({});
  };

  const openReview = (survey: any) => {
    setSelectedSurvey(survey);
    setAction(null);
    setNote('');
    setDesignerId('');
    setVarianceNotes({});
  };

  // Who to hand the design task to on approval. Previously nothing in the
  // app ever set design_tasks.designer_id, so every task sat on
  // "Designer: Unassigned" forever. Fetched only once Approve is actually
  // picked inside the drawer, same lazy pattern as ShopDetailPage's
  // fieldWorkers query.
  const { data: designers } = useQuery({
    queryKey: ['org-designers', orgId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name')
        .eq('organization_id', orgId)
        .eq('role', 'designer')
        .eq('is_active', true)
        .order('full_name');
      if (error) throw new Error(`Could not load designers: ${error.message}`);
      return data as { id: string; full_name: string }[];
    },
    enabled: !!orgId && !!selectedSurvey && action === 'approve',
  });

  const { data: surveys, error: surveysError, isLoading: surveysLoading } = useQuery({
    queryKey: ['surveys-review', orgId],
    queryFn: async () => {
      // `surveys` has TWO foreign keys into `profiles` (surveyor_id AND
      // reviewed_by). A plain `profiles(full_name)` embed is ambiguous to
      // PostgREST ("more than one relationship was found") and the whole
      // request errors out — silently, because the old code only read
      // `data` and ignored `error`, so `data` came back `undefined` and
      // this page just rendered as if there were 0 surveys, while the
      // sidebar badge (a separate, non-embedding count query) still
      // correctly showed the real count. That's exactly the "badge says 1,
      // page says 0" bug. Naming the FK column (`profiles:surveyor_id`)
      // resolves the ambiguity, and the query now throws instead of
      // failing silently so this class of bug surfaces immediately next
      // time instead of just showing an empty list.
      const { data, error } = await supabase
        .from('surveys')
        .select('*, shops(name, city, purchase_order_id, clients(name)), profiles:surveyor_id(full_name)')
        .eq('organization_id', orgId)
        .in('status', ['submitted', 'approved', 'rejected', 'correction_requested'])
        .order('submitted_at', { ascending: false });
      if (error) throw new Error(`Could not load surveys: ${error.message}`);
      return data;
    },
    enabled: !!orgId,
  });

  // A survey submitted from a surveyor's phone should appear here live,
  // without the Admin/Owner needing to already have this tab closed and
  // reopened — see DashboardPage / AdminLayout for the same fix elsewhere.
  useRealtimeInvalidate(['surveys'], orgId, [['surveys-review', orgId]]);

  const reviewMutation = useMutation({
    mutationFn: async () => {
      if (!selectedSurvey || !action) return;
      const newStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'correction_requested';

      // Every write below now checks `.error` and throws on failure instead
      // of firing-and-forgetting. Previously an update could fail silently
      // (RLS, a bad value, whatever) and the code would carry on as if it
      // succeeded — e.g. the survey itself never actually flipping to
      // 'approved' while the shop still moved on to 'design_pending', so
      // the shop would look further along than its survey record actually
      // was. Now the whole review action fails together and shows an error
      // instead of leaving things half-updated.
      const { error: surveyError } = await supabase.from('surveys').update({
        status: newStatus,
        reviewed_at: new Date().toISOString(),
        reviewed_by: profile!.id,
        review_note: note || null,
      }).eq('id', selectedSurvey.id).select('id');
      if (surveyError) throw new Error(`Could not update survey: ${surveyError.message}`);

      if (action === 'approve' && !designerId) {
        throw new Error('Pick a designer to assign this task to before approving.');
      }

      if (action === 'approve') {
        // Previously set to 'approved' and stopped there — with nothing
        // ever creating a design_tasks row, the shop had no next step
        // anywhere in the app (Design Queue stayed empty forever). Now it
        // moves to 'design_pending' (the status the Dashboard and Design
        // Queue actually look for) and a design_tasks row is created so
        // it's immediately visible to the design team.
        const { error: shopError } = await supabase.from('shops').update({ status: 'design_pending' }).eq('id', selectedSurvey.shop_id).select('id');
        if (shopError) throw new Error(`Could not move shop to design_pending: ${shopError.message}`);

        // Copy survey measurements to approved, and mark each item approved
        // so it shows up correctly on the Production page's work-items list
        // later (which filters on work_items.status, not just shop.status).
        const { data: items, error: itemsFetchError } = await supabase.from('work_items').select('*').eq('survey_id', selectedSurvey.id);
        if (itemsFetchError) throw new Error(`Could not load work items: ${itemsFetchError.message}`);
        if (items) {
          for (const item of items) {
            // Section 8 — if Admin/Owner typed an adjustment note for this
            // item (shown alongside the PO budget banner when the running
            // total exceeds the line item's budget), record it against the
            // work item along with who acknowledged it and when. Never
            // required — approval still proceeds with no note at all, the
            // variance itself was never blocking, only ever visible.
            const adjustmentNote = varianceNotes[item.id]?.trim();
            const { error: itemError } = await supabase.from('work_items').update({
              approved_width: item.survey_width,
              approved_height: item.survey_height,
              approved_unit: item.survey_unit,
              approved_quantity: item.survey_quantity,
              approved_area: item.survey_area,
              approved_notes: item.survey_notes,
              status: 'approved',
              ...(adjustmentNote
                ? { po_variance_note: adjustmentNote, po_variance_acknowledged_by: profile!.id, po_variance_acknowledged_at: new Date().toISOString() }
                : {}),
            }).eq('id', item.id).select('id');
            if (itemError) throw new Error(`Could not approve work item: ${itemError.message}`);
          }
        }

        // Create the design task (only if one doesn't already exist for
        // this shop, e.g. a re-approval after a correction round).
        const { data: existingTask, error: existingTaskError } = await supabase
          .from('design_tasks')
          .select('id')
          .eq('shop_id', selectedSurvey.shop_id)
          .maybeSingle();
        if (existingTaskError) throw new Error(`Could not check for existing design task: ${existingTaskError.message}`);
        if (!existingTask) {
          const { error: taskInsertError } = await supabase.from('design_tasks').insert({
            organization_id: selectedSurvey.organization_id,
            shop_id: selectedSurvey.shop_id,
            status: 'assigned',
            designer_id: designerId,
          });
          if (taskInsertError) throw new Error(`Could not create design task: ${taskInsertError.message}`);
          await createNotification(designerId, 'New Design Task', `You've been assigned to design ${selectedSurvey.shops?.name}`, 'info', '/design');
        } else {
          // Re-approval after a correction round — the task already
          // exists, so just (re)assign the designer instead of skipping.
          const { error: taskUpdateError } = await supabase.from('design_tasks').update({ designer_id: designerId }).eq('id', existingTask.id).select('id');
          if (taskUpdateError) throw new Error(`Could not assign designer: ${taskUpdateError.message}`);
          await createNotification(designerId, 'Design Task Assigned', `You've been assigned to design ${selectedSurvey.shops?.name}`, 'info', '/design');
        }
      } else if (action === 'reject' || action === 'correction') {
        // Send the shop back to 'assigned' so it re-appears on the
        // surveyor's own Home/My Work list and "Start Survey" is
        // re-enabled — otherwise a rejected/correction survey was a dead
        // end the surveyor could never actually act on.
        const { error: shopError } = await supabase.from('shops').update({ status: 'assigned' }).eq('id', selectedSurvey.shop_id).select('id');
        if (shopError) throw new Error(`Could not reset shop status: ${shopError.message}`);
        const { error: assignError } = await supabase.from('shop_assignments').update({ status: 'assigned', completed_at: null })
          .eq('shop_id', selectedSurvey.shop_id).eq('user_id', selectedSurvey.surveyor_id).eq('role', 'surveyor').select('id');
        if (assignError) throw new Error(`Could not reset surveyor assignment: ${assignError.message}`);
      }

      await logAudit('surveys', selectedSurvey.id, action, 'status', selectedSurvey.status, newStatus, `Survey ${action} for ${selectedSurvey.shops?.name}`);
      await createNotification(selectedSurvey.surveyor_id, `Survey ${action}`, `Your survey for ${selectedSurvey.shops?.name} was ${action === 'correction' ? 'requested for correction' : action + 'd'}. ${note || ''}`, 'info');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['surveys-review', orgId] });
      queryClient.invalidateQueries({ queryKey: ['design-task-list'] });
      queryClient.invalidateQueries({ queryKey: ['design-task-stats'] });
      queryClient.invalidateQueries({ queryKey: ['shops'] });
      // The sidebar's "Survey Review" badge count lives in its own query
      // (AdminLayout's `nav-pending-counts`), separate from this page's own
      // `surveys-review` list. It was never invalidated here, so approving/
      // rejecting a survey updated this page instantly but left the sidebar
      // badge showing the old count until the next realtime event or the
      // 15s poll fallback caught up (or forever, if Realtime isn't enabled
      // on the Supabase project) — e.g. the badge still saying "1" while
      // this page correctly shows "0 pending review". Invalidate it here so
      // both always agree the moment an action completes.
      queryClient.invalidateQueries({ queryKey: ['nav-pending-counts', orgId] });
      closeDrawer();
    },
  });

  const pendingReview = (surveys || []).filter((s) => s.status === 'submitted');
  const reviewed = (surveys || []).filter((s) => s.status !== 'submitted');

  // Confirm is locked until a decision is actually made, and — for
  // reject/correction — until there's a note, since "declined, no reason
  // given" leaves the surveyor with nothing to act on.
  const noteRequired = action === 'reject' || action === 'correction';
  const canConfirm = !!action && (action !== 'approve' || !!designerId) && (!noteRequired || note.trim().length > 0);

  return (
    <div>
      <PageHeader title="Survey Review" subtitle={`${pendingReview.length} pending review`} />

      {surveysError && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3 mb-4" role="alert">
          Could not load surveys: {(surveysError as Error).message}
        </p>
      )}

      <h2 className="text-lg font-semibold text-slate-900 mb-3">Pending Review</h2>
      {surveysLoading ? (
        <p className="text-sm text-slate-400 mb-8">Loading surveys…</p>
      ) : pendingReview.length === 0 ? (
        <div className="mb-8">
          <EmptyState icon={<FileText className="w-12 h-12" />} title="No surveys pending review" />
        </div>
      ) : (
        <SurveyTable
          surveys={pendingReview}
          variant="pending"
          onReview={openReview}
        />
      )}

      {reviewed.length > 0 && (
        <>
          <h2 className="text-lg font-semibold text-slate-900 mb-3">Recently Reviewed</h2>
          <SurveyTable
            surveys={reviewed.slice(0, 10)}
            variant="reviewed"
            onReview={openReview}
          />
        </>
      )}

      <Drawer
        open={!!selectedSurvey}
        onClose={closeDrawer}
        width="lg"
        title={selectedSurvey?.shops?.name || 'Survey'}
        subtitle={selectedSurvey ? `${selectedSurvey.shops?.clients?.name || 'No client'} · ${selectedSurvey.shops?.city || ''}` : undefined}
      >
        {selectedSurvey && (
          <div className="space-y-6">
            {/* ── 1. Survey details, always visible first, before any decision is made ── */}
            <div className="flex items-center gap-2 flex-wrap">
              <StatusBadge status={selectedSurvey.status} />
              <span className="text-xs text-slate-400">·</span>
              <span className="text-xs text-slate-500">
                Surveyed by <span className="font-medium text-slate-700">{selectedSurvey.profiles?.full_name || 'Unknown'}</span>
              </span>
              {selectedSurvey.submitted_at && (
                <>
                  <span className="text-xs text-slate-400">·</span>
                  <span className="text-xs text-slate-500">Submitted {new Date(selectedSurvey.submitted_at).toLocaleString('en-IN')}</span>
                </>
              )}
            </div>

            {selectedSurvey.gps_lat != null && selectedSurvey.gps_lng != null && (
              <p className="flex items-center gap-1.5 text-xs text-slate-500">
                <MapPin className="w-3.5 h-3.5 shrink-0" />
                Location captured at {selectedSurvey.gps_lat.toFixed(5)}, {selectedSurvey.gps_lng.toFixed(5)}
                {selectedSurvey.gps_accuracy != null && ` (±${Math.round(selectedSurvey.gps_accuracy)}m)`}
              </p>
            )}

            {selectedSurvey.notes && (
              <div className="flex gap-2 text-sm bg-slate-50 border border-slate-200 rounded-lg p-3">
                <StickyNote className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                <p className="text-slate-700">{selectedSurvey.notes}</p>
              </div>
            )}

            <ReviewMarkedPhotos surveyId={selectedSurvey.id} />

            <SurveyMeasurementsTable surveyId={selectedSurvey.id} />

            <POBudgetReviewPanel
              surveyId={selectedSurvey.id}
              shopId={selectedSurvey.shop_id}
              purchaseOrderId={selectedSurvey.shops?.purchase_order_id || null}
              varianceNotes={varianceNotes}
              onNoteChange={(itemId, val) => setVarianceNotes((prev) => ({ ...prev, [itemId]: val }))}
              readOnly={action !== 'approve'}
            />

            {/* ── 2. Decision, only after everything above has actually been seen ── */}
            {isPendingSurvey ? (
              <div className="sticky bottom-0 -mx-5 px-5 pb-5 pt-4 bg-white border-t border-slate-200 space-y-4">
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Decision</p>
                  <div className="grid grid-cols-3 gap-2" role="group" aria-label="Review decision">
                    <button
                      type="button"
                      aria-pressed={action === 'approve'}
                      onClick={() => setAction('approve')}
                      className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition ${
                        action === 'approve' ? 'bg-green-600 text-white border-green-600' : 'bg-green-50 text-green-700 border-green-200 hover:bg-green-100'
                      }`}
                    >
                      <CheckCircle2 className="w-4 h-4" /> Approve
                    </button>
                    <button
                      type="button"
                      aria-pressed={action === 'correction'}
                      onClick={() => setAction('correction')}
                      className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition ${
                        action === 'correction' ? 'bg-amber-600 text-white border-amber-600' : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                      }`}
                    >
                      <AlertCircle className="w-4 h-4" /> Correction
                    </button>
                    <button
                      type="button"
                      aria-pressed={action === 'reject'}
                      onClick={() => setAction('reject')}
                      className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition ${
                        action === 'reject' ? 'bg-red-600 text-white border-red-600' : 'bg-red-50 text-red-700 border-red-200 hover:bg-red-100'
                      }`}
                    >
                      <XCircle className="w-4 h-4" /> Reject
                    </button>
                  </div>
                </div>

                {action === 'approve' && (
                  <>
                    <Select
                      label="Assign Designer"
                      value={designerId}
                      onChange={setDesignerId}
                      options={[
                        { value: '', label: 'Select a designer...' },
                        ...(designers || []).map((d) => ({ value: d.id, label: d.full_name })),
                      ]}
                      required
                    />
                    {designers && designers.length === 0 && (
                      <p className="text-xs text-amber-600">
                        No active designers found in your organization. Add one from Owner Console → Users first.
                      </p>
                    )}
                  </>
                )}

                {action && (
                  <Textarea
                    label={`Review Note (sent to surveyor)${noteRequired ? ' — required' : ''}`}
                    value={note}
                    onChange={setNote}
                    rows={3}
                    placeholder={action === 'approve' ? 'Optional note...' : 'Explain what needs to be corrected so the surveyor can fix it...'}
                  />
                )}

                {reviewMutation.isError && (
                  <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-2" role="alert">
                    {(reviewMutation.error as Error).message}
                  </p>
                )}

                <button
                  onClick={() => reviewMutation.mutate()}
                  disabled={!canConfirm || reviewMutation.isPending}
                  className={`w-full text-white font-medium py-2.5 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed ${
                    action === 'approve' ? 'bg-green-600 hover:bg-green-700' : action === 'reject' ? 'bg-red-600 hover:bg-red-700' : 'bg-amber-600 hover:bg-amber-700'
                  }`}
                >
                  {reviewMutation.isPending
                    ? 'Processing...'
                    : action
                      ? `Confirm ${action === 'approve' ? 'Approval' : action === 'reject' ? 'Rejection' : 'Correction Request'}`
                      : 'Choose a decision above'}
                </button>
              </div>
            ) : (
              <div className="border-t border-slate-200 pt-4 space-y-2">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">Past Decision</p>
                <div className="flex items-center gap-2">
                  <StatusBadge status={selectedSurvey.status} />
                  {selectedSurvey.reviewed_at && (
                    <span className="text-xs text-slate-500">on {new Date(selectedSurvey.reviewed_at).toLocaleString('en-IN')}</span>
                  )}
                </div>
                {selectedSurvey.review_note && (
                  <p className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3">{selectedSurvey.review_note}</p>
                )}
              </div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}

// Proper list (not cards) so an org with many shops can scan submissions
// quickly: one row per survey, key facts in fixed columns, a single
// "Review" action that opens full details before any decision is made.
function SurveyTable({
  surveys, variant, onReview,
}: {
  surveys: any[];
  variant: 'pending' | 'reviewed';
  onReview: (survey: any) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm mb-8">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 border-b border-slate-200">
          <tr>
            <th scope="col" className="text-left font-medium text-slate-500 px-4 py-2.5">Shop</th>
            <th scope="col" className="text-left font-medium text-slate-500 px-4 py-2.5">Client / City</th>
            <th scope="col" className="text-left font-medium text-slate-500 px-4 py-2.5">Surveyor</th>
            <th scope="col" className="text-left font-medium text-slate-500 px-4 py-2.5">{variant === 'pending' ? 'Submitted' : 'Reviewed'}</th>
            <th scope="col" className="text-left font-medium text-slate-500 px-4 py-2.5">Status</th>
            {variant === 'reviewed' && <th scope="col" className="text-left font-medium text-slate-500 px-4 py-2.5">Note</th>}
            <th scope="col" className="text-right font-medium text-slate-500 px-4 py-2.5">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {surveys.map((s) => (
            <tr key={s.id} className="hover:bg-slate-50">
              <td className="px-4 py-3 font-medium text-slate-900 whitespace-nowrap">{s.shops?.name}</td>
              <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{s.shops?.clients?.name || '—'} · {s.shops?.city}</td>
              <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{s.profiles?.full_name || 'Unknown'}</td>
              <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                {new Date(variant === 'pending' ? s.submitted_at : s.reviewed_at).toLocaleString('en-IN', variant === 'pending' ? undefined : { dateStyle: 'medium' })}
              </td>
              <td className="px-4 py-3"><StatusBadge status={s.status} /></td>
              {variant === 'reviewed' && (
                <td className="px-4 py-3 text-slate-500 max-w-[220px] truncate" title={s.review_note || ''}>{s.review_note || '—'}</td>
              )}
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-3">
                  <Link
                    to={`/shops/${s.shop_id}`}
                    className="text-slate-400 hover:text-blue-600"
                    aria-label={`Open ${s.shops?.name} shop page`}
                    title="Open shop page"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Link>
                  <button
                    onClick={() => onReview(s)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${
                      variant === 'pending'
                        ? 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100'
                        : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    {variant === 'pending' ? 'Review' : 'View'}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Full measurement breakdown for every work item on the survey, shown
// unconditionally in the review drawer — previously the only thing an
// Admin/Owner could see about what was actually measured was the PO
// budget panel below, which only renders line items tied to a purchase
// order. A shop with no PO (or items not linked to one) showed no
// measurements at all, so approval was effectively a decision made from
// photos alone.
function SurveyMeasurementsTable({ surveyId }: { surveyId: string }) {
  const { data: items, isLoading } = useQuery({
    queryKey: ['review-survey-measurements', surveyId],
    queryFn: async () => {
      const { data, error } = await supabase.from('work_items').select('*').eq('survey_id', surveyId).order('work_type_name');
      if (error) throw new Error(`Could not load measurements: ${error.message}`);
      return data as WorkItem[];
    },
    enabled: !!surveyId,
  });

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
        Measurements{items && items.length > 0 ? ` (${items.length})` : ''}
      </p>
      {isLoading ? (
        <p className="text-xs text-slate-400">Loading measurements…</p>
      ) : !items || items.length === 0 ? (
        <p className="text-xs text-slate-400">No measurements recorded for this survey.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th scope="col" className="text-left font-medium text-slate-500 px-3 py-2">Work Type</th>
                <th scope="col" className="text-left font-medium text-slate-500 px-3 py-2">Material</th>
                <th scope="col" className="text-right font-medium text-slate-500 px-3 py-2">Size</th>
                <th scope="col" className="text-right font-medium text-slate-500 px-3 py-2">Qty</th>
                <th scope="col" className="text-right font-medium text-slate-500 px-3 py-2">Area</th>
                <th scope="col" className="text-left font-medium text-slate-500 px-3 py-2">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="px-3 py-2 font-medium text-slate-800 whitespace-nowrap">{item.work_type_name || '—'}</td>
                  <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{item.material || '—'}</td>
                  <td className="px-3 py-2 text-slate-600 text-right whitespace-nowrap">
                    {item.survey_width != null && item.survey_height != null
                      ? `${item.survey_width} × ${item.survey_height} ${item.survey_unit || ''}`
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-slate-600 text-right whitespace-nowrap">{item.survey_quantity ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-600 text-right whitespace-nowrap">
                    {item.survey_area != null ? `${item.survey_area.toFixed(2)} sqft` : '—'}
                  </td>
                  <td className="px-3 py-2 text-slate-500 max-w-[180px] truncate" title={item.survey_notes || ''}>
                    {item.survey_notes || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Section 8 — read-only live comparison of each surveyed work item against
// its PO line item's budget, shown at the review gate exactly like it's
// shown to the surveyor while measuring (SurveyorPage.tsx). Never a hard
// block: if the running total exceeds budget, Admin/Owner can optionally
// type an adjustment note explaining the variance, saved onto the work
// item only when the survey is actually approved (see reviewMutation).
function POBudgetReviewPanel({
  surveyId, shopId, purchaseOrderId, varianceNotes, onNoteChange, readOnly,
}: {
  surveyId: string;
  shopId: string;
  purchaseOrderId: string | null;
  varianceNotes: Record<string, string>;
  onNoteChange: (itemId: string, val: string) => void;
  readOnly: boolean;
}) {
  const { data: items } = useQuery({
    queryKey: ['review-po-work-items', surveyId],
    queryFn: async () => {
      const { data, error } = await supabase.from('work_items').select('*').eq('survey_id', surveyId);
      if (error) throw error;
      return data as WorkItem[];
    },
    enabled: !!surveyId,
  });

  const { data: lineItems } = useQuery({
    queryKey: ['review-po-line-items', purchaseOrderId],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_po_line_item_work_context').select('*').eq('purchase_order_id', purchaseOrderId);
      if (error) throw error;
      return data as POLineItemWorkContext[];
    },
    enabled: !!purchaseOrderId,
  });

  const lineItemIds = (lineItems || []).map((li) => li.id);
  const { data: elsewhereSums } = useQuery({
    queryKey: ['review-po-elsewhere', shopId, lineItemIds.join(',')],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('work_items')
        .select('po_line_item_id, survey_area, survey_quantity')
        .in('po_line_item_id', lineItemIds)
        .neq('shop_id', shopId);
      if (error) throw error;
      const sums: Record<string, { area: number; qty: number }> = {};
      for (const row of data || []) {
        if (!row.po_line_item_id) continue;
        const cur = sums[row.po_line_item_id] || { area: 0, qty: 0 };
        cur.area += row.survey_area || 0;
        cur.qty += row.survey_quantity || 0;
        sums[row.po_line_item_id] = cur;
      }
      return sums;
    },
    enabled: lineItemIds.length > 0,
  });

  const linked = (items || []).filter((it) => it.po_line_item_id);
  if (!purchaseOrderId || linked.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">PO Budget Check</p>
      {linked.map((item) => {
        const lineItem = (lineItems || []).find((li) => li.id === item.po_line_item_id);
        if (!lineItem) return null;
        const areaBased = lineItem.uom === 'sqft';
        const elsewhere = elsewhereSums?.[lineItem.id];
        const surveyedElsewhere = areaBased ? (elsewhere?.area || 0) : (elsewhere?.qty || 0);
        const thisMeasurement = areaBased ? (item.survey_area || 0) : (item.survey_quantity || 0);
        const fig = computePOVariance(lineItem, surveyedElsewhere, thisMeasurement);
        const unitLabel = areaBased ? 'sqft' : lineItem.uom;
        return (
          <div key={item.id} className={`rounded-lg p-3 text-xs space-y-1 border ${fig.exceeds ? 'bg-amber-50 border-amber-300' : 'bg-slate-50 border-slate-200'}`}>
            <p className="font-medium text-slate-700">
              {item.work_type_name} — {lineItem.name ? `${lineItem.name} (${lineItem.po_number})` : `PO ${lineItem.po_number}`} budget: {fig.budgeted != null ? `${fig.budgeted} ${unitLabel}` : 'not set'}
            </p>
            <p className="text-slate-500">Already surveyed elsewhere: {fig.surveyedElsewhere.toFixed(2)} {unitLabel} · This shop: {fig.thisMeasurement.toFixed(2)} {unitLabel}</p>
            <p className={fig.exceeds ? 'text-amber-700 font-semibold' : 'text-slate-700 font-medium'}>
              Running total: {fig.runningTotal.toFixed(2)}{fig.budgeted != null ? ` / ${fig.budgeted} ${unitLabel} (${fig.pct?.toFixed(0)}%)` : ` ${unitLabel}`}
            </p>
            {fig.exceeds && (
              <>
                <p className="text-amber-700 flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5" /> Exceeds PO budget by {fig.exceedsBy.toFixed(2)} {unitLabel}
                </p>
                {!readOnly && (
                  <input
                    type="text"
                    value={varianceNotes[item.id] || ''}
                    onChange={(e) => onNoteChange(item.id, e.target.value)}
                    placeholder="Optional adjustment note explaining the variance..."
                    className="w-full mt-1 text-xs border border-amber-300 rounded px-2 py-1.5 bg-white"
                  />
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Shows the marked board photos for a submitted survey, so Admin/Owner can
// This used to render photos itself with a sequential for-await loop that
// committed React state exactly once, after every photo finished — so a
// single photo whose renderMarkedImage() call failed or hung (a CORS
// hiccup, a slow network) silently dropped every photo after it from that
// one state commit, and the whole batch could end up showing just the
// first photo marked (or none at all) even though every photo genuinely
// had valid markings. src/components/MarkedPhotoGrid.tsx already fixes
// exactly this — each photo renders as its own independent, timed-out-
// isolated promise and updates the instant it's ready — but was never
// actually wired up here (or in ShopsPages.tsx / InstallerPage.tsx, which
// each had their own copy of the same bug). Now this component only
// fetches the data; MarkedPhotoGrid owns all the rendering, so the owner
// sees exactly the same reliable marked photos the agency and client
// sides already do.
function ReviewMarkedPhotos({ surveyId }: { surveyId: string }) {
  const { data: photos } = useQuery({
    queryKey: ['review-survey-photos', surveyId],
    queryFn: async () => {
      const { data } = await supabase.from('survey_photos').select('*').eq('survey_id', surveyId).order('created_at');
      return data as SurveyPhoto[];
    },
    enabled: !!surveyId,
  });

  const { data: markings } = useQuery({
    queryKey: ['review-board-markings', surveyId, photos],
    queryFn: async () => {
      const photoIds = (photos || []).map((p) => p.id);
      if (photoIds.length === 0) return [] as BoardMarking[];
      const { data } = await supabase.from('board_markings').select('*').in('survey_photo_id', photoIds);
      return data as BoardMarking[];
    },
    enabled: !!photos,
  });

  // Needed so each marked board's caption (work type + dimensions) can be
  // burned onto the photo itself, matching what the surveyor saw while
  // marking it, instead of the reviewer having to cross-reference a
  // separate work-items list against an unlabeled photo.
  const { data: workItems } = useQuery({
    queryKey: ['review-work-items', surveyId],
    queryFn: async () => {
      const { data } = await supabase.from('work_items').select('*').eq('survey_id', surveyId);
      return data as WorkItem[];
    },
    enabled: !!surveyId,
  });

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
        Survey Photos{photos && photos.length > 0 ? ` (${photos.length})` : ''}
      </p>
      <MarkedPhotoGrid photos={photos || []} markings={markings || []} workItems={workItems || []} />
    </div>
  );
}
