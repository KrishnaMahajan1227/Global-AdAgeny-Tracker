/** Extra Excel fields follow the site record into assigned field staff screens. */
export function ShopAdditionalDetails({ details }: { details?: Record<string, unknown> | null }) {
  const entries = Object.entries(details || {}).filter(([key, value]) =>
    key.trim() && value !== null && value !== undefined && String(value).trim()
  );
  if (!entries.length) return null;
  return (
    <details className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <summary className="cursor-pointer text-xs font-semibold text-slate-700">Additional site details ({entries.length})</summary>
      <dl className="mt-2 space-y-1.5 text-xs text-slate-700">
        {entries.map(([key, value]) => (
          <div key={key} className="flex flex-wrap gap-1">
            <dt className="font-medium">{key}:</dt>
            <dd className="break-words">{String(value)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
