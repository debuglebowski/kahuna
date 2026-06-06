export type Role = "owner" | "admin" | "member"
export type Action = "read" | "write" | "admin"

/**
 * v1 permission model (replaces a permissions table): a `member` reads/writes
 * everything in their org; `owner`/`admin` can additionally administer.
 */
export const can = (role: Role, action: Action): boolean => {
  switch (action) {
    case "read":
    case "write":
      return role === "owner" || role === "admin" || role === "member"
    case "admin":
      return role === "owner" || role === "admin"
  }
}
