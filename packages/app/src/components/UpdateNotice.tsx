import { useQuery } from "@tanstack/react-query"
import { ArrowUpCircle } from "lucide-react"
import { useState } from "react"
import { api } from "../lib/api"
import { cn } from "../lib/utils"
import { Modal } from "./ui"

/**
 * Sidebar footer notice: "New version available", opening a modal with what to do
 * about it. Renders NOTHING unless the server reports a newer release, so the
 * sidebar is unchanged on an up-to-date install (and on a `dev` checkout, which
 * never claims an update).
 *
 * The modal deliberately gives INSTRUCTIONS, not a button that upgrades. The
 * correct order is `migrate` with the NEW image and only then `serve`
 * (docker-entrypoint.sh makes migrate its own command precisely so replicas can't
 * race the DDL), and the server cannot know whether it is under compose,
 * Kubernetes, Nomad or a bare systemd unit. So: name the invariant, show the
 * compose commands as the common case, and say plainly that other orchestrators
 * have their own primitive for it.
 *
 * Also note the two facts that bite AFTER an upgrade goes wrong, since this is
 * the one moment the operator is thinking about it: rollback is not symmetric
 * (no down migrations), and uploaded files are not in pg_dump.
 */
export function UpdateNotice({ collapsed }: { collapsed: boolean }) {
  const [open, setOpen] = useState(false)
  // Cached for an hour to match the server's own poll — this is a background
  // fact, not something worth refetching on every sidebar mount.
  const v = useQuery({
    queryKey: ["version"],
    queryFn: api.getVersion,
    staleTime: 60 * 60 * 1000,
  })

  // Owns its own divider so the whole section — border included — disappears on
  // an up-to-date install rather than leaving a stray rule above the user block.
  if (!v.data?.updateAvailable) return null

  return (
    <div className="border-t border-sidebar-border p-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Version ${v.data.latest} is available`}
        aria-label={`New version ${v.data.latest} available`}
        className={cn(
          "flex items-center rounded-lg text-left transition-colors hover:bg-sidebar-accent",
          collapsed ? "w-full justify-center p-2" : "w-full gap-2.5 px-2 py-2",
        )}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <ArrowUpCircle size={16} className="text-info" />
        </span>
        {!collapsed && (
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium text-sidebar-foreground">New version</div>
            <div className="truncate text-xs text-sidebar-foreground/70">
              {v.data.current} → {v.data.latest}
            </div>
          </div>
        )}
      </button>

      {open && (
        <Modal title="Update available" onClose={() => setOpen(false)}>
          <div className="space-y-4 text-sm">
            <div className="flex items-center gap-2">
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {v.data.current}
              </code>
              <span className="text-muted-foreground">→</span>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {v.data.latest}
              </code>
            </div>

            <p className="text-muted-foreground">
              Nothing has been downloaded or changed — updating is done from wherever this
              recordVersion is deployed.
            </p>

            <div className="space-y-1.5">
              <p className="font-medium">Apply migrations before serving the new version</p>
              <p className="text-muted-foreground">
                The new image must run its migrations <em>before</em> it starts serving. Running
                them as a separate step keeps replicas from racing the same schema change, and makes
                a failed migration fail loudly instead of vanishing into startup logs.
              </p>
            </div>

            <div className="space-y-1.5">
              <p className="font-medium">With Docker Compose</p>
              <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
                {`docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml run --rm app migrate
docker compose -f docker-compose.prod.yml up -d`}
              </pre>
              <p className="text-xs text-muted-foreground">
                On Kubernetes, Nomad, ECS or systemd, use that platform's equivalent pre-deploy step
                (a Helm <code className="font-mono">pre-upgrade</code> hook, a prestart task, and so
                on) to run <code className="font-mono">migrate</code> first.
              </p>
            </div>

            <div className="space-y-1.5 rounded-md border border-border bg-muted/40 p-3">
              <p className="font-medium">Before you upgrade</p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>Read the release notes — they call out anything needing a manual step.</li>
                <li>
                  Back up first. Migrations only move forward, so rolling the image back leaves the
                  database on the newer schema; recovery is a restore.
                </li>
                <li>
                  Uploaded files are not included in a database dump — back up the blob storage
                  volume separately.
                </li>
              </ul>
            </div>

            <a
              className="inline-block underline underline-offset-2"
              href="https://github.com/debuglebowski/kahuna/releases"
              target="_blank"
              rel="noreferrer noopener"
            >
              Release notes for {v.data.latest}
            </a>
          </div>
        </Modal>
      )}
    </div>
  )
}
