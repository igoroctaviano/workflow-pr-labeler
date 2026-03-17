# Workflow PR Labeler

A GitHub Action that automatically updates pull request labels based on configurable rules. Define which labels to add or remove when a PR is opened, closed, merged, reviewed, or when review is requested.

## Features

- **Event-driven**: React to `pull_request`, `pull_request_review`, and `pull_request_review_comment` events
- **Configurable**: YAML config for each event (e.g. `onOpen`, `onMerge`, `onReviewPending`)
- **Label lifecycle**: Create missing labels and sync add/remove in one place
- **Re-request support**: Handles review requested / re-requested via `onReRequestReview` or `onReviewPending` fallback

## Requirements

- A GitHub repository with pull requests enabled
- A workflow that runs on `pull_request`, `pull_request_review`, and/or `pull_request_review_comment`
- A YAML config file (e.g. in the repo root) and `GITHUB_TOKEN` (or `secrets.GITHUB_TOKEN`)

## Installation

### 1. Add a workflow

Create or edit `.github/workflows/labeler.yml` in your repository:

```yaml
name: PR labeler

on:
  pull_request:
    types: [opened, closed, reopened]
  pull_request_review:
    types: [submitted]
  pull_request_review_comment:
    types: [created]

jobs:
  label:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Update PR labels
        uses: igoroctaviano/workflow-pr-labeler@master
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          CONFIG_PATH: labeler-config.yml
```

### 2. Create the config file

Create `labeler-config.yml` in the root of your repository (or another path and set `CONFIG_PATH` accordingly).

## Configuration

Config is a single YAML file with two kinds of keys:

1. **`createLabels`** (optional): Labels to create in the repo if they don’t exist. Each item has `name`, optional `description`, and `color` (hex without `#`).
2. **Event handlers**: For each event you want to react to, specify `remove` (list of label names to remove) and/or `set` (list of label names to add).

| Handler            | When it runs |
|--------------------|--------------|
| `onOpen`           | PR is opened |
| `onClose`          | PR is closed (not merged) |
| `onMerge`          | PR is merged |
| `onReviewPending`  | Review state is pending (e.g. from GraphQL) |
| `onReRequestReview` | Someone requests or re-requests review (`review_requested`; no review in payload) |
| `onComment`       | A review is submitted with state “commented” |
| `onApprove`        | A review is submitted with state “approved” |
| `onChangeRequest`  | A review is submitted with “changes requested” |

If `onReRequestReview` is not defined and the event is review requested, the action falls back to `onReviewPending` when present.

### Example config

```yaml
createLabels:
  - name: Working on it
    description: Author is working on changes
    color: 01AEEB
  - name: Pull Request
    description: Open pull request
    color: 01AEEB
  - name: Resolved
    description: Merged or done
    color: 01AEEB

onOpen:
  remove: [Resolved, Working on it]
  set: [Pull Request]

onReRequestReview:
  remove: [Working on it, Resolved]
  set: [Pull Request]

onClose:
  remove: [Resolved, Pull Request]
  set: [Working on it]

onMerge:
  remove: [Working on it, Pull Request]
  set: [Resolved]

onComment:
  remove: [Pull Request, Resolved]
  set: [Working on it]

onChangeRequest:
  remove: [Resolved, Pull Request]
  set: [Working on it]
```

- **`remove`**: Labels to remove from the PR (by name).
- **`set`**: Labels to add. Only names listed here are added; other existing labels are left as-is.
- You can omit `remove` or `set` for an event if you only want to add or only remove.

## Inputs

| Input          | Required | Description |
|----------------|----------|-------------|
| `GITHUB_TOKEN` | Yes      | Token with repo access (e.g. `secrets.GITHUB_TOKEN`) |
| `CONFIG_PATH`  | Yes      | Path to the labeler YAML config (e.g. `labeler-config.yml`) |

## Logs

All action output is prefixed with `[workflow-pr-labeler]` so you can filter logs in the workflow run. The step logs the GitHub event payload, PR info, matched action, and which labels were added or removed.

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

Copyright (c) 2019 igoroctaviano
