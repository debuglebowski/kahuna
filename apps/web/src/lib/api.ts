/** A field-value bag for an instance's projected state. */
export type State = Record<string, unknown>

export interface Instance {
  readonly id: string
  readonly conceptId: string
  readonly state: State
  readonly version: number
  readonly createdAt: string
  readonly deletedAt: string | null
}

export interface Concept {
  readonly id: string
  readonly name: string
  readonly description: string | null
}

export interface DecayValue {
  readonly days: number | null
  readonly band: "fresh" | "warm" | "cooling" | "cold"
}
export interface MomentumValue {
  readonly label: "heating" | "steady" | "cooling"
  readonly recent: number
  readonly prior: number
}

export interface Attachment {
  readonly id: string
  readonly instanceId: string
  readonly filename: string
  readonly mimeType: string | null
  readonly sizeBytes: number | null
  readonly createdAt: string
}

export type ArtifactWithFiles = Instance & { readonly attachments: Attachment[] }

export interface AccountHub {
  readonly account: Instance
  readonly contacts: Instance[]
  readonly owners: Instance[]
  readonly interactions: Instance[]
  readonly signals: Instance[]
  readonly artifacts: ArtifactWithFiles[]
  readonly tasks: Instance[]
  readonly deals: Instance[]
}

export interface Owed {
  readonly openTasks: Instance[]
  readonly decayingDeals: Instance[]
  readonly dueRenewals: Instance[]
}

export interface FeedItem {
  readonly id: number
  readonly occurredAt: string
  readonly actor: string | null
  readonly eventType: string
  readonly subjectKind: string
  readonly subjectId: string
}

export interface DemandItem {
  readonly signal: Instance
  readonly accountId: string | null
  readonly accountName: string | null
  readonly weight: number
}

export interface Me {
  readonly userId: string
  readonly email: string
  readonly name: string
  readonly orgId: string | null
  readonly role: string | null
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, {
    headers: { "content-type": "application/json", ...init?.headers },
    ...init,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export const apiGet = <T>(path: string) => request<T>(path)
export const apiPost = <T>(path: string, body: unknown) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) })
