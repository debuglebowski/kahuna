import { useMutation, useQuery } from "@tanstack/react-query"
import { Mail, RefreshCw, Send } from "lucide-react"
import { useState } from "react"
import { Button, Card, CardHeader, Field, Input, Spinner } from "../components/ui"
import { api, type GoogleThread } from "../lib/api"

const upgradeUrl = (capability: string) => {
  const u = new URL("/api/integrations/google/connect", window.location.origin)
  u.searchParams.append("capability", capability)
  u.searchParams.set("returnTo", "/google/mail")
  return u.pathname + u.search
}

export function GoogleMail() {
  const threads = useQuery({ queryKey: ["googleThreads"], queryFn: api.listGoogleThreads })
  const [selected, setSelected] = useState<GoogleThread | null>(null)
  const messages = useQuery({
    queryKey: ["googleThread", selected?.id],
    queryFn: () => api.getGoogleThread(selected!.id),
    enabled: Boolean(selected),
    retry: false,
  })
  const [to, setTo] = useState("")
  const [subject, setSubject] = useState("")
  const [text, setText] = useState("")
  const send = useMutation({
    mutationFn: () => api.sendGoogleMessage({ to, subject, text }),
    onSuccess: () => {
      setTo("")
      setSubject("")
      setText("")
      threads.refetch()
    },
    retry: false,
  })

  if (threads.isPending) return <Spinner />

  const readScopeNeeded = messages.error?.message === "GMAIL_READ_SCOPE_REQUIRED"
  const sendScopeNeeded = send.error?.message === "GMAIL_SEND_SCOPE_REQUIRED"

  return (
    <div className="grid min-h-[calc(100dvh-3rem)] gap-5 lg:grid-cols-[minmax(260px,360px)_1fr]">
      <Card className="min-h-0">
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Mail size={16} />
              Gmail
            </span>
          }
          action={
            <Button type="button" variant="outline" onClick={() => threads.refetch()}>
              <RefreshCw size={15} />
              Refresh
            </Button>
          }
        />
        <div className="divide-y overflow-y-auto">
          {threads.error && (
            <p className="p-6 text-sm text-destructive">{(threads.error as Error).message}</p>
          )}
          {threads.data?.length === 0 && (
            <p className="p-6 text-sm text-muted-foreground">No synced threads.</p>
          )}
          {threads.data?.map((thread) => (
            <button
              type="button"
              key={thread.id}
              onClick={() => setSelected(thread)}
              className="block w-full p-4 text-left transition-colors hover:bg-accent"
            >
              <div className="truncate text-sm font-medium">{thread.subject ?? "No subject"}</div>
              <div className="mt-1 truncate text-xs text-muted-foreground">
                {thread.from_email ?? "Unknown sender"}
              </div>
              {thread.snippet && (
                <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {thread.snippet}
                </div>
              )}
            </button>
          ))}
        </div>
      </Card>

      <div className="space-y-5">
        <Card>
          <CardHeader title="Compose" />
          <div className="space-y-3 p-4">
            <Field label="To">
              <Input value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field label="Subject">
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
            </Field>
            <Field label="Body">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="min-h-28 w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            </Field>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                onClick={() => send.mutate()}
                disabled={send.isPending || !to || !subject || !text}
              >
                <Send size={15} />
                {send.isPending ? "Sending..." : "Send"}
              </Button>
              {sendScopeNeeded && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => (window.location.href = upgradeUrl("gmail.send"))}
                >
                  Enable send
                </Button>
              )}
              {send.error && !sendScopeNeeded && (
                <span className="text-sm text-destructive">{send.error.message}</span>
              )}
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title={selected?.subject ?? "Thread"} />
          <div className="divide-y">
            {!selected && <p className="p-6 text-sm text-muted-foreground">Select a thread.</p>}
            {readScopeNeeded && (
              <div className="p-6">
                <Button
                  type="button"
                  onClick={() => (window.location.href = upgradeUrl("gmail.read"))}
                >
                  Enable mail read
                </Button>
              </div>
            )}
            {messages.isFetching && <Spinner />}
            {messages.data?.map((message) => (
              <div key={message.id} className="space-y-2 p-4">
                <div className="text-xs text-muted-foreground">
                  {message.from_email ?? "Unknown sender"}
                  {message.sent_at ? ` · ${new Date(message.sent_at).toLocaleString()}` : ""}
                </div>
                <div className="whitespace-pre-wrap text-sm">
                  {message.body_text ?? message.snippet ?? ""}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
