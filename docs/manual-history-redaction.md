# Manual history redaction

For an assessed erasure request or due record, an authorised operator removes personal
**content**, including earlier event values. This operator tool complements app
editing/purge; it is not automatic retention or proof of complete subject erasure.

1. Use existing request/retention handling to decide what must go and what has a
   justified retention ground. Find the person's actual data and spelling/case
   variants, including archived versions, notes/tasks, files and external copies.
   The tool matches exact, case-sensitive text across one organisation's history;
   inspect every affected event before applying. **Do not use if any matching
   history must be retained**; obtain a scoped implementation instead.
2. Through supported app actions, clear current values and all relevant record
   versions/notes/tasks; purge unwanted files. Verify blob removal: app purge is
   best effort. Pause app writes and integrations for the maintenance window.
   Use authorised database access.
3. From a reviewed source checkout, explicitly set `DATABASE_URL` through the
   existing secure session. Create a private, permission-0600 input file:
   `{"orgId":"ORG-UUID","terms":["Full exact name","exact@email.example"]}`.
   Run from `packages/app`:

   ```sh
   bun scripts/redact-history.ts /private/input.json --database=NAME
   bun scripts/redact-history.ts /private/input.json --database=NAME --apply=PREVIEW_DIGEST
   ```

   Preview writes nothing. Apply checks the digest, preserves event structure
   and metadata, and commits all payload edits together. It refuses matches in
   current org-scoped rows, structural fields or event identity metadata.
4. Rerun preview (zero matches), verify app/history/search and a record rebuild,
   and check files separately. Retain a content-free receipt in the existing case;
   remove the temporary input after use. Resume writes. If any check fails, leave
   the case open and escalate through existing engineering handling.
5. Existing recovery copies may retain old data for their documented period
   specified by the deployment; verify expiry. Keep the restricted erasure
   instructions until they expire and reapply before reopening any restore.

The tool does not discover a person's data, remove authentication accounts or
pseudonymous actor IDs, scan file contents, erase security logs/exports, or clear
storage versions/backups. Assess those separately; retained identifiers are
not anonymous. Short values (<4 characters), IDs and unsupported cases need a
reviewed targeted method. No blanket erasure exception is implied.
