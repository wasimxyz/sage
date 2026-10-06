# Releasing Sage

This page explains how to publish a Sage release and how installed copies find it. You push a version tag, GitHub Actions packages the app, and the release carries a disk image for new installs and a signed update feed for copies that are already installed.

## What a release contains

A release has three files, all built from the same commit. The version in the names is the `version` in `app.json`.

- `Sage-0.1.0-macos.dmg`: the disk image for new installs
- `Sage-0.1.0-macos-update.zip`: the app bundle that installed copies download
- `native-update.json`: the update feed, signed with the update key

Builds are for Apple silicon only. They are signed ad hoc, so there is no Developer ID signature and no notarization yet. Release builds leave Memories off, because `SAGE_MEMORY` keeps its default of `false`.

## The update key

The feed is signed with an Ed25519 key. The public half is in `app.json` under `updates.public_key`, and an installed Sage trusts only that key. The private half is in the `UPDATE_PRIVATE_KEY` repository secret, as base64.

Keep a backup of the private key outside the repository. If you lose it, installed copies can never verify another update, and people have to download a new build by hand. Sage cannot move a copy to a new key.

To replace the key, generate a new one, store it in the secret, and put the public key it prints in `app.json`:

```bash
native update keygen --private-key ~/.keys/sage-update.key
```

```bash
base64 -i ~/.keys/sage-update.key | gh secret set UPDATE_PRIVATE_KEY
```

Copies built with the old key do not update to builds signed with the new one.

## Cut a release

A release starts with a version bump and ends with a tag on `main`.

1. Set the new version everywhere. It must be three numbers, such as `0.1.1`, because the updater rejects anything else. The files are `app.json`, `build.zig.zon`, `frontend/package.json`, `agent/package.json`, `agent/packages/world-encrypted-local/package.json`, and `eval-viewer/package.json`, plus the matching entries in each `package-lock.json`. `make check` runs `scripts/release-version.sh`, which lists every file that disagrees with `app.json`.
2. Merge the change to `main`.
3. Tag the merge commit and push the tag:

```bash
git tag v0.1.1
git push origin v0.1.1
```

To rehearse a release, push a tag such as `v0.1.1-rc.1`. An `rc` tag builds the version in `app.json` and publishes a GitHub prerelease. The feed URL points at the latest full release, so installed copies never see a prerelease.

## What the workflow does

`.github/workflows/release.yml` runs on every pushed tag that starts with `v`. It does this, in order:

1. Checks that the tag is on `main` and that its version matches `app.json`.
2. Installs Zig, Node.js, the pinned Native SDK CLI, and the dependencies.
3. Runs `native validate app.json`, `make check`, and `make test`.
4. Runs `make package-archive`, which builds the `.app` with Chat and Node.js inside, then the DMG and the update ZIP.
5. Signs the ZIP into `native-update.json`. The signer also checks that the ZIP holds an arm64 app with the right bundle ID and version.
6. Creates a draft release with the three files, then publishes it. Publishing last means “latest” never points at a release that is missing its ZIP.

GitHub writes the release notes. The feed’s own notes are empty, so the update dialog says only that the version is ready to install.

## If the workflow fails

A failure before step 6 publishes nothing. Fix the cause, delete the tag, and push it again:

```bash
git tag -d v0.1.1
git push origin :refs/tags/v0.1.1
```

A failure during step 6 can leave a draft release. Delete the draft on GitHub first, since creating a release fails when one already exists for the tag.

## Install a release

macOS blocks the first launch of an ad-hoc signed app. Open the DMG, drag Sage to Applications, and open it once. On macOS 15 and later, go to System Settings > Privacy & Security and choose **Open Anyway** next to the message about Sage. On earlier versions, Control-click Sage and choose **Open**.

Updates replace the app in place, so keep Sage in a folder you can write to.

## How installed copies update

Sage fetches the feed from `https://github.com/wasimxyz/sage/releases/latest/download/native-update.json` when it starts, and stays quiet unless a newer version exists. You can also choose **Check for updates** in the Sage menu.

When a newer version exists, Sage offers **Install Update**. It checks the feed signature against the public key in the app, downloads the ZIP, and checks the ZIP’s size and SHA-256 against the signed feed. Then it quits, replaces the app, and opens the new one. If the swap fails, it puts the old app back.

Some limits to know:

- The folder that holds Sage must be writable. Otherwise Sage asks you to move it or update by hand.
- Every update downloads the full app. There are no delta updates, channels, or staged rollouts.
- Updates run only from a packaged `.app`, not from `make dev`.
