import { useQuery } from "@tanstack/react-query"
import { CalendarDays, ExternalLink, RefreshCw } from "lucide-react"
import { Button, Card, CardHeader, Spinner } from "../components/ui"
import { api } from "../lib/api"

export function GoogleCalendar() {
  const events = useQuery({
    queryKey: ["googleCalendarEvents"],
    queryFn: api.listGoogleCalendarEvents,
  })

  if (events.isPending) return <Spinner />

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-2xl font-bold tracking-tight text-foreground">Google Calendar</h2>
        <Button type="button" variant="outline" onClick={() => events.refetch()}>
          <RefreshCw size={15} />
          Refresh
        </Button>
      </div>
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <CalendarDays size={16} />
              Events
            </span>
          }
        />
        <div className="divide-y">
          {events.error && (
            <p className="p-6 text-sm text-destructive">{(events.error as Error).message}</p>
          )}
          {events.data?.length === 0 && (
            <p className="p-6 text-sm text-muted-foreground">No synced events.</p>
          )}
          {events.data?.map((event) => (
            <div key={event.id} className="flex items-start justify-between gap-4 p-4">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{event.summary ?? "Untitled"}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {event.start_at ? new Date(event.start_at).toLocaleString() : "No start"}
                  {event.location ? ` · ${event.location}` : ""}
                </div>
              </div>
              {event.html_link && (
                <Button asChild type="button" variant="ghost" size="icon-sm">
                  <a href={event.html_link} target="_blank" rel="noreferrer" aria-label="Open event">
                    <ExternalLink size={14} />
                  </a>
                </Button>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
