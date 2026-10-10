import { readFileSync } from "node:fs"
import path from "node:path"
import { KahunaRpcs } from "@kahunalabs/contract"
import { describe, expect, it } from "vitest"
import { ADMIN_READS, AUDITED_RPCS } from "./rpcAudit"

/**
 * The invariant that keeps the audit trail complete: every RPC handler behind an
 * admin gate is either audited or explicitly listed as a read. A new admin-gated RPC
 * fails this test until someone decides which, so it cannot ship silently uncovered.
 *
 * It reads rpc.ts as text on purpose — the gate helpers are applied inside each
 * handler body, so there is no runtime registry to ask.
 */
// Call syntax only, and comments stripped first: "admin" appears in prose all over rpc.ts.
const GATE =
  /\b(?:admin|adminOn|adminOnFieldConcept|adminSqlOn)[<(]|\brequireAction\(|\brequireAdmin\b/
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const adminGatedHandlers = (): string[] => {
  const src = readFileSync(path.join(import.meta.dirname, "rpc.ts"), "utf8")
  const body = stripComments(src.slice(src.indexOf("const HandlersLive")))
  const heads = [...body.matchAll(/^ {4}(\w+): /gm)]
  return heads
    .filter((m, i) => GATE.test(body.slice(m.index, heads[i + 1]?.index ?? body.length)))
    .map((m) => m[1] as string)
}

describe("RPC audit coverage", () => {
  it("every admin-gated handler is audited or a declared admin read", () => {
    const gated = adminGatedHandlers()
    // Guards the parser itself: if the handler layout changes and it finds nothing,
    // the check below would pass vacuously.
    expect(gated.length).toBeGreaterThan(40)
    const uncovered = gated.filter((n) => !(n in AUDITED_RPCS) && !ADMIN_READS.has(n))
    expect(uncovered, `admin-gated RPCs with no audit decision: ${uncovered.join(", ")}`).toEqual(
      [],
    )
  })

  it("nothing is both audited and declared a read", () => {
    expect([...ADMIN_READS].filter((n) => n in AUDITED_RPCS)).toEqual([])
  })

  it("every named RPC exists in the contract", () => {
    for (const n of [...Object.keys(AUDITED_RPCS), ...ADMIN_READS])
      expect(KahunaRpcs.requests.has(n), n).toBe(true)
  })
})
