import { latestVersionName, nextVersionName } from "@kahunalabs/contract"
import { useMutation } from "@tanstack/react-query"
import { Check, Rocket, Send, X } from "lucide-react"
import { useState } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { api, type Concept, type RecordVersion } from "../../lib/api"
import { DatePicker } from "../DatePicker"
import { memberLabel, type OrgMember } from "../record/AssigneePicker"
import { Button, Field, Input, Modal } from "../ui"

/**
 * Release info for a version — the policy "Document History" row.
 *
 * `publish`: a free-text name (pre-filled by bumping the previous one's last
 * number), change note, document date and an approver — required when the
 * concept says every publish needs approval, optional otherwise. With an
 * approver the submit becomes "Request approval": the draft locks and the
 * approver signs off in Kahuna.
 *
 * `info`: backfill an already-published version (imported records start at v1
 * unnamed). Author/approver here are RECORDED names — for history from before
 * Kahuna; versions published in Kahuna record who did it on their own.
 */
export function ReleaseModal({
  mode,
  version,
  versions,
  concept,
  members,
  myUserId,
  onClose,
  onDone,
}: {
  mode: "publish" | "info"
  version: RecordVersion
  versions: ReadonlyArray<RecordVersion>
  concept: Concept
  members: ReadonlyArray<OrgMember>
  myUserId: string | undefined
  onClose: () => void
  onDone: () => void
}) {
  const r = version.release
  const previous = latestVersionName(versions.filter((v) => v.id !== version.id && !v.archivedAt))
  const [name, setName] = useState(mode === "info" ? (r.name ?? "") : nextVersionName(previous))
  const [note, setNote] = useState(r.note ?? "")
  const [date, setDate] = useState(r.effectiveDate ?? "")
  const [approverId, setApproverId] = useState<string | null>(null)
  const [author, setAuthor] = useState(r.attributedAuthor ?? "")
  const [approverName, setApproverName] = useState(r.attributedApprover ?? "")

  const approverRequired = mode === "publish" && concept.approvalPolicy === "all"
  const candidates = members.filter((m) => m.userId !== myUserId)

  const save = useMutation({
    mutationFn: async () => {
      const text = {
        name: name.trim() || null,
        note: note.trim() || null,
        effectiveDate: date || null,
      }
      if (mode === "publish") {
        await api.publishVersion(version.id, version.version, { ...text, approverId })
      } else {
        await api.setVersionInfo(version.id, {
          ...text,
          attributedAuthor: author.trim() || null,
          attributedApprover: approverName.trim() || null,
        })
      }
    },
    onSuccess: () => {
      onDone()
      onClose()
    },
  })

  const blocked = approverRequired && !approverId
  const label = mode === "info" ? "Save" : approverId ? "Request approval" : "Publish"
  const Icon = mode === "info" ? Check : approverId ? Send : Rocket

  return (
    <Modal
      title={
        mode === "info"
          ? `Version info — ${r.name ?? `v${version.versionSeq}`}`
          : `Publish v${version.versionSeq}`
      }
      onClose={onClose}
    >
      <div className="space-y-4">
        <Field label="Version" hint={previous ? `Previous: ${previous}` : undefined}>
          <Input
            value={name}
            placeholder={`v${version.versionSeq}`}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Change note">
          <Textarea
            value={note}
            rows={3}
            placeholder="What changed and why"
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <Field label="Date" hint="The document date. Empty = the day it's published.">
          <DatePicker
            value={date || undefined}
            onChange={setDate}
            onClear={() => setDate("")}
            placeholder="Publish date"
            triggerClassName="h-9 rounded-md border px-3"
          />
        </Field>
        {mode === "publish" ? (
          <Field
            label={approverRequired ? "Approver" : "Approver (optional)"}
            hint="They sign off in Kahuna; it publishes when they approve. Gets a task."
          >
            <Select
              // "" shows the placeholder: when an approver is required there's no
              // "No approval" item for "__none" to match, which rendered blank.
              value={approverId ?? (approverRequired ? "" : "__none")}
              onValueChange={(v) => setApproverId(v === "__none" ? null : v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose an approver" />
              </SelectTrigger>
              <SelectContent>
                {!approverRequired && <SelectItem value="__none">No approval</SelectItem>}
                {candidates.map((m) => (
                  <SelectItem key={m.userId} value={m.userId}>
                    {memberLabel(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <>
            <Field label="Written by" hint="Recorded name, for history from before Kahuna.">
              <Input value={author} onChange={(e) => setAuthor(e.target.value)} />
            </Field>
            <Field label="Approved by" hint="Recorded name, for history from before Kahuna.">
              <Input value={approverName} onChange={(e) => setApproverName(e.target.value)} />
            </Field>
          </>
        )}
        <div className="flex gap-2">
          <Button onClick={() => save.mutate()} disabled={save.isPending || blocked}>
            <Icon size={15} />
            {save.isPending ? "Saving…" : label}
          </Button>
          <Button variant="outline" onClick={onClose}>
            <X size={15} />
            Cancel
          </Button>
        </div>
        {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
      </div>
    </Modal>
  )
}
