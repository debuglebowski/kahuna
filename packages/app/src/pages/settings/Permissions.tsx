import { MyAccess } from "./MyAccess"

/** Its own destination under Settings → Account, lifted out of Profile: the
 *  self-serve "why can/can't I see X?" report is substantial enough (roles,
 *  the full rule list with its layer, and the interactive explain tool) to
 *  not be one more card partway down another page. */
export function Permissions() {
  return <MyAccess />
}
