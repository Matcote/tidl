# Releases

## Normal release

Open **Actions → Release → Run workflow** on `main`. Leave `operation=prepare`,
choose `patch` (default), `minor`, or `major`, and leave `dry_run` unchecked.
That click authorizes submission and automatic publication after Google review.
Ordinary pushes never publish the extension.

The workflow checks the store state, bumps all version files, tests, typechecks,
builds and scans one ZIP, saves a recovery artifact, atomically pushes the release
commit and annotated tag, creates a GitHub release, and submits that same ZIP.
The summary identifies the source/release commits, ZIP checksum, and store status.
"Submitted for review" is not "published"; Google sends its usual review emails.
Use `operation=status` to check without waiting on a running Actions job.

Node 24, Git, npm, `zip`, `unzip`, and GitHub CLI are used. The workflow pins the
runner to Ubuntu 24.04 and external Actions to commit SHAs. Dependencies are
installed with `npm ci`. Keep action pins updated through reviewed changes.

## First-time Chrome Web Store setup

If the extension has only been loaded unpacked, there is no store item to update yet.

1. [Register a Chrome Web Store developer account](https://developer.chrome.com/docs/webstore/register),
   pay Google's one-time registration fee, and enable two-step verification.
2. Run `npm run package` with the real public TIDAL client ID in `.env` or
   `TIDAL_CLIENT_ID`. Upload the ZIP as a **new item** in the developer dashboard.
   Complete the store listing, privacy disclosures, distribution, and review
   instructions. Creating a draft does not publish it.
3. Record the extension ID from this item and publisher ID from **Publisher → Settings**.
   Register `https://<store-extension-id>.chromiumapp.org/` in the TIDAL OAuth app;
   the store ID can differ from your unpacked development ID. Verify login with
   the store identity before the initial submission.
4. Establish the intended store visibility in the dashboard. If Google requires
   an initial manual submission for the chosen visibility, complete that before
   relying on API updates. The workflow does not edit listing/privacy metadata.
5. Configure the Google account connection below. Run **Release → status** to
   verify access and the current store version before a live prepare run.

The repo starts at `0.1.2`; a patch normally proposes `0.1.3`. Do not assume that
matches the store: the workflow rejects versions older than or equal to the
published version, or a conflicting pending review. If the store is ahead,
update all three tracked version files to its current version in a normal commit
before preparing the next release.

## Google account connection (once)

Use an existing Google Cloud project where you can administer IAM, or create a
project for tIDl. No service-account key or OAuth refresh token is needed.
The project ID, publisher ID, and extension ID are configuration, not secrets.

Authenticate locally with `gcloud auth login`. In the following commands, replace
`PROJECT_ID`, `PUBLISHER_ID`, and `EXTENSION_ID` with the actual values. They are
intentionally not checked into the repository. Run these setup commands once;
if a resource already exists, inspect and reuse it instead of recreating it.

```bash
export TIDL_GCP_PROJECT=PROJECT_ID
export TIDL_CWS_PUBLISHER=PUBLISHER_ID
export TIDL_CWS_EXTENSION=EXTENSION_ID
export TIDL_REPOSITORY=Matcote/tidl
export TIDL_SA="tidl-publisher@${TIDL_GCP_PROJECT}.iam.gserviceaccount.com"
export TIDL_PROJECT_NUMBER="$(gcloud projects describe "$TIDL_GCP_PROJECT" --format='value(projectNumber)')"
export TIDL_REPOSITORY_ID="$(gh api "repos/$TIDL_REPOSITORY" --jq .id)"
export TIDL_OWNER_ID="$(gh api "repos/$TIDL_REPOSITORY" --jq .owner.id)"

gcloud services enable chromewebstore.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project="$TIDL_GCP_PROJECT"
gcloud iam service-accounts create tidl-publisher --project="$TIDL_GCP_PROJECT" --display-name='tIDl publisher'
gcloud iam workload-identity-pools create github --project="$TIDL_GCP_PROJECT" --location=global --display-name='GitHub Actions'
gcloud iam workload-identity-pools providers create-oidc tidl \
  --project="$TIDL_GCP_PROJECT" --location=global --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping='google.subject=assertion.sub,attribute.repository_id=assertion.repository_id' \
  --attribute-condition="assertion.repository_id == '$TIDL_REPOSITORY_ID' && assertion.repository_owner_id == '$TIDL_OWNER_ID' && assertion.ref == 'refs/heads/main' && assertion.event_name == 'workflow_dispatch' && assertion.workflow_ref == '$TIDL_REPOSITORY/.github/workflows/release.yml@refs/heads/main'"
gcloud iam service-accounts add-iam-policy-binding "$TIDL_SA" \
  --project="$TIDL_GCP_PROJECT" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$TIDL_PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository_id/$TIDL_REPOSITORY_ID"
```

Add `TIDL_SA`'s email in the Chrome Web Store developer dashboard's **Account**
service-account setting. Google currently permits one linked service account
per publisher: reuse an existing one if present and adapt the commands above.
Do not assign broad project Editor/Owner roles to the publishing service account.

Configure these repository **Actions variables**, using Settings → Secrets and
variables → Actions → Variables, or the commands below:

```bash
gh variable set GCP_PROJECT_ID --repo "$TIDL_REPOSITORY" --body "$TIDL_GCP_PROJECT"
gh variable set GCP_SERVICE_ACCOUNT --repo "$TIDL_REPOSITORY" --body "$TIDL_SA"
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo "$TIDL_REPOSITORY" \
  --body "projects/$TIDL_PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/tidl"
gh variable set CWS_PUBLISHER_ID --repo "$TIDL_REPOSITORY" --body "$TIDL_CWS_PUBLISHER"
gh variable set CWS_EXTENSION_ID --repo "$TIDL_REPOSITORY" --body "$TIDL_CWS_EXTENSION"
gh variable set TIDAL_CLIENT_ID --repo "$TIDL_REPOSITORY" --body 'YOUR_REAL_PUBLIC_TIDAL_CLIENT_ID'
```

`Release → status` uses the read-only Web Store scope. Publishing uses the
`chromewebstore` scope and fresh credentials immediately before upload. Both
are restricted to the configured repository/main/release workflow. PR checks
use a fixture public client ID, have no publishing credentials, and cannot
produce artifacts accepted by `resume`.

References: [Google service-account setup](https://developer.chrome.com/docs/webstore/service-accounts),
[GitHub authentication action](https://github.com/google-github-actions/auth),
[Web Store v2 API](https://developer.chrome.com/docs/webstore/using-api).

## Dry runs and local packaging

Before the first live release, run **Release → prepare → dry_run=true**. This
needs no Google configuration. Without a configured public client ID it uses
`tidl-ci-fixture-not-for-publication`; the resulting extension cannot log in.
With the real variable, use the ZIP for a manual login/search/favorite/playlist
smoke check. Dry-run metadata always makes it ineligible for automated publishing.

Dry runs do not push commits/tags or create GitHub releases/store submissions.
They do save a clearly named **Actions artifact** for inspection (90 days).
A local dry run additionally restores all three version files after success or
failure and creates no local commit or tag:

```bash
npm ci
npm run release -- prepare --bump patch --dry-run
```

Preparation requires a clean tree, matching versions, and a Git `origin` remote.
Version components must be 0–65535 with no leading zeros and cannot all be zero.
A dev-server URL or missing client ID stops packaging. Process environment takes
precedence over `.env`, including an explicitly empty client ID.

`npm run package` builds/scans the current version without a version bump.
It produces `releases/tidl-<version>.zip` and `.zip.sha256`; run tests/typecheck
separately for manual releases. Only `prepare` also creates the tag-bound `.json`
metadata needed for automated publication.

## Failure recovery

All operations share one concurrency group. A second queued run cannot interrupt
an active submission. Avoid manual uploads while the workflow is running.

| Failure point | Recovery |
| --- | --- |
| Validation/build/checks failed | Fix the failure, commit it, start a new prepare run. No release refs were pushed. |
| `main` advanced before atomic push | Start prepare again from current main. No release refs were pushed. |
| Tag pushed, GitHub release absent or incomplete | Choose `resume`, supply `release_tag=vX.Y.Z` and the **original preparation** `source_run_id`. |
| GitHub release exists, upload/submission failed | Choose `resume` with its tag. It downloads the original assets; no build or bump occurs. |
| Upload timeout/unknown validation | Inspect the dashboard first. The API cannot bind a draft status to a ZIP checksum. Resume re-uploads the same verified ZIP if it is not already submitted. |
| Submission timeout | Run status. Resume recognizes the same version in review/published and does not send another submission. |
| Rejected/cancelled submission | Inspect Google's feedback and release a corrected higher version; automation does not resubmit it blindly. |
| Original assets missing/expired | Recover the original ZIP/checksum/metadata from the original run or saved download. Stop if unavailable; never rebuild an existing release version. |

A recovery artifact must originate from this repository's main-branch Release
workflow, and its metadata checksum must match the annotated release tag.
The tag binds source/release commits, version, store destination, original run,
and ZIP checksum. Existing GitHub assets are compared and never overwritten.
A different pending store version is never replaced. Release commits/tags are
never force-pushed, deleted, or rewritten. For a published defect, release a fix
with a higher version; reversing a GitHub release does not roll back Chrome.

The live workflow uses `GITHUB_TOKEN` with job-scoped `contents: write` on the
currently unprotected `main`. If branch rules later require PRs, adjust the
release process explicitly; this workflow will fail rather than bypass them.
GitHub releases mean "packaged release"; store availability is reported by the
Release status operation and Google's review notification.
