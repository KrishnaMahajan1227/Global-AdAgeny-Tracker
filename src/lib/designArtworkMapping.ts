/**
 * Design artwork coverage is file -> exact work-item(s), never "all selected boards"
 * for every file. This pure module is deliberately shared by the preview and
 * save validation so the UI cannot display one mapping and persist another.
 */
export type DesignBoard = { id: string; status: string };
export type DesignFileAssignment = { id: string; workItemIds: string[] };
export type DesignLink = { work_item_id: string; design_version_id: string };
export type DesignVersionState = { id: string; status: string };

const UNAPPROVED = new Set(['pending', 'surveyed']);
const LOCKED = new Set(['design_approved', 'in_production', 'produced', 'production_done', 'installed', 'billed', 'cancelled', 'rejected']);
const EDITABLE = new Set(['approved', 'designing', 'designed']);

export function editableDesignBoards(items: DesignBoard[]): DesignBoard[] {
  return items.filter((item) => EDITABLE.has(item.status));
}

export function validateArtworkMappings(items: DesignBoard[], files: DesignFileAssignment[]): string | null {
  if (!items.length) return 'No Work Items are linked to this shop. Add the required work items before uploading artwork.';
  if (!files.length) return 'Select at least one artwork file.';
  const editableIds = new Set(editableDesignBoards(items).map((item) => item.id));
  if (editableIds.size === 0) return 'There are no editable design boards in this shop.';
  for (const [index, file] of files.entries()) {
    if (file.workItemIds.length === 0) return `Map artwork ${index + 1} to at least one marking or board.`;
    if (new Set(file.workItemIds).size !== file.workItemIds.length) return 'A marking was assigned twice to the same file.';
    if (file.workItemIds.some((id) => !editableIds.has(id))) return 'A file is mapped to another shop or a locked/unapproved board. Reload the task.';
  }
  return null;
}

export function designCoverage(
  items: DesignBoard[],
  versions: DesignVersionState[],
  existingLinks: DesignLink[],
  files: DesignFileAssignment[],
) {
  const knownIds = new Set(versions.filter(v => !['rejected', 'deleted'].includes(v.status)).map(v => v.id));
  const covered = new Set(existingLinks.filter(link => knownIds.has(link.design_version_id)).map(link => link.work_item_id));
  for (const file of files) for (const id of file.workItemIds) covered.add(id);
  const missing = items.filter(item => !LOCKED.has(item.status) && !covered.has(item.id));
  const ready = items.length > 0 && editableDesignBoards(items).length > 0 &&
    !items.some(item => UNAPPROVED.has(item.status) || (!EDITABLE.has(item.status) && !LOCKED.has(item.status))) && missing.length === 0;
  return { covered, missing, ready };
}
