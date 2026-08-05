export function Placeholder({ title }: { title: string }) {
  return (
    <div className="space-y-5">
      <h2 className="text-2xl font-bold tracking-tight text-foreground">{title}</h2>
      <div className="flex min-h-[300px] items-center justify-center rounded-xl border border-dashed p-12">
        <p className="text-sm text-muted-foreground">{title} — coming soon.</p>
      </div>
    </div>
  )
}
