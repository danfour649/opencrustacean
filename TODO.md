# TODO

## CI — installer_smoke disabled (Blacksmith outage)

- TODO(2026-10-19): Re-enable the `installer_smoke` job in
  `.github/workflows/install-smoke-reusable.yml` once Blacksmith's Docker
  builder is healthy again.

  **Fix to apply** (requires an agent/human with the GitHub `workflows`
  permission — Muse's GitHub App cannot edit `.github/workflows/` files):

  In `.github/workflows/install-smoke-reusable.yml`, in the `installer_smoke:`
  job block, change:

  ```yaml
  if: needs.preflight.outputs.run_full_install_smoke == 'true'
  ```

  to:

  ```yaml
  # TODO(2026-10-19): re-enable installer_smoke once the Blacksmith Docker
  # builder outage is resolved. Disabled 2026-10-12 after "Run installer
  # docker tests" failed on the fallback local builder (run 38239868381).
  if: false # needs.preflight.outputs.run_full_install_smoke == 'true'
  ```

  **Why:** On 2026-10-12 the scheduled "Install Smoke" workflow failed on main
  (run 38239868381, commit 727dde85). Only the `installer_smoke` job failed —
  the "Run installer docker tests" step exited 1 after ~18m. The check-run
  annotations show Blacksmith's Docker builder setup failing ("grpc connection
  test failed: [canceled]", "Failed to report error to Blacksmith: 401") with
  fallback to a local builder, after which the docker tests died. Infra issue,
  not a code issue.

  **Re-enable:** restore the original `if:` line (delete the `if: false`)
  once Blacksmith builder setup succeeds again. Verify with a passing
  `installer_smoke` run before closing this TODO.
