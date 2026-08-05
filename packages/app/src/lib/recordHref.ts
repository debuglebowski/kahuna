/**
 * The ONE place that builds a link to a record's detail page. Centralised so a
 * reference can opt into a specific record dashboard (`?view=<id>`) without every
 * call site re-deriving the URL. A bare link (no `dashboard`) lands on the
 * concept's default record view; `RecordView` resolves the `view` param.
 */

export interface RecordHrefOpts {
  /** Open the record with this record-dashboard id (a 'record' dashboard owned by
   *  the record's concept). Absent/null → the concept's default record view. */
  readonly dashboard?: string | null
}

/** The route to a record's detail page, optionally pinned to a record dashboard.
 *  Query param (not a path segment) so existing bare links keep resolving. */
export const recordHref = (recordVersionId: string, opts?: RecordHrefOpts): string =>
  opts?.dashboard
    ? `/records/${recordVersionId}?view=${encodeURIComponent(opts.dashboard)}`
    : `/records/${recordVersionId}`
