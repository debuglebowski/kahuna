/** Inline success/error line shared by the settings forms. */
export function Feedback({
  ok,
  okText,
  error,
}: {
  ok?: boolean
  okText?: string
  error?: unknown
}) {
  if (error) {
    return (
      <p className="text-sm text-red-600">{(error as Error)?.message ?? "Something went wrong."}</p>
    )
  }
  if (ok) return <p className="text-sm text-green-600">{okText ?? "Saved."}</p>
  return null
}
