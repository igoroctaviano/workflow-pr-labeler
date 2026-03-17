import * as core from '@actions/core'
import * as github from '@actions/github'
import * as _ from 'lodash'
import * as yaml from 'js-yaml'
import * as fs from 'fs'

const LOG_PREFIX = '[workflow-pr-labeler]'

function log(message: string, ...args: unknown[]): void {
  console.log(LOG_PREFIX, message, ...args)
}

type Label = {
  color: string
  default: boolean
  id: string
  name: string
  node_id: string
  url: string
}

type PRInfo = {
  nodeId: string
  /** From payload.review.state when present; null when event has no review (e.g. review_requested) */
  reviewState:
    | 'commented'
    | 'approved'
    | 'changes_requested'
    | 'dismissed'
    | 'pending' /** PullRequestReviewState */
    | null
  state: 'merged' | 'closed' | 'open' /** PullRequestState */
  merged: boolean
  assignees: { login: string }[]
  requested_reviewers: { login: string }[]
  assignee: { login: string }[] | undefined
  labels: Label[]
  repoName: string
}

type PRAction = {
  set: string[] | undefined
  remove: string[] | undefined
}

type LabelsIdsToMutate = {
  selectedLabelsToAssign: string[]
  selectedLabelsToRemove: string[]
}

async function run() {
  try {
    const token = core.getInput('GITHUB_TOKEN', { required: true })
    const configPath = core.getInput('CONFIG_PATH', { required: true })

    const configObj: any = yaml.safeLoad(fs.readFileSync(configPath, 'utf8'))
    if (!configObj) {
      core.setFailed('There is no configuration to set the labels')
      return
    }

    const prInfo = getPRInfo()
    if (!prInfo) {
      return
    }

    const client = new github.GitHub(token)
    const labels = await getLabels(client, prInfo.repoName)
    if (!labels.length) {
      core.setFailed('There are no labels in this project')
      return
    }

    await createLabels(client, configObj, labels, prInfo)

    log('GitHub context payload', github.context.payload)
    log('PR info', prInfo)
    const payload = github.context.payload as {
      action?: string
      pull_request?: { number?: number }
    }
    log(
      `Event: ${payload.action || 'unknown'}, PR #${
        (payload.pull_request && payload.pull_request.number) || '?'
      }, state: ${prInfo.state}`
    )

    let githubAction
    let matchedAction: string | null = null
    if (
      prInfo.state === 'open' &&
      configObj.onOpen &&
      github.context.payload.action === 'opened'
    ) {
      matchedAction = 'onOpen'
      githubAction = configObj.onOpen
    }
    if (prInfo.reviewState === 'pending' && configObj.onReviewPending) {
      matchedAction = 'onReviewPending'
      githubAction = configObj.onReviewPending
    }
    if (prInfo.reviewState === 'commented' && configObj.onComment) {
      matchedAction = 'onComment'
      githubAction = configObj.onComment
    }
    if (prInfo.reviewState === 'approved' && configObj.onApprove) {
      matchedAction = 'onApprove'
      githubAction = configObj.onApprove
    }
    if (
      prInfo.reviewState === 'changes_requested' &&
      configObj.onChangeRequest
    ) {
      matchedAction = 'onChangeRequest'
      githubAction = configObj.onChangeRequest
    }
    if (prInfo.merged === true && configObj.onMerge) {
      matchedAction = 'onMerge'
      githubAction = configObj.onMerge
    }
    if (
      prInfo.merged !== true &&
      prInfo.state === 'closed' &&
      configObj.onClose
    ) {
      matchedAction = 'onClose'
      githubAction = configObj.onClose
    }
    /** Review requested or re-requested: payload has no review, so reviewState is null */
    const isReviewRequested =
      github.context.payload.action === 'review_requested' &&
      prInfo.requested_reviewers.length > 0 &&
      !prInfo.reviewState
    if (isReviewRequested && configObj.onReRequestReview) {
      matchedAction = 'onReRequestReview'
      githubAction = configObj.onReRequestReview
    }
    /** Fallback: treat review_requested as "review pending" if onReRequestReview not set */
    if (isReviewRequested && !githubAction && configObj.onReviewPending) {
      matchedAction = 'onReviewPending (review_requested fallback)'
      githubAction = configObj.onReviewPending
    }

    if (!githubAction) {
      log('No configuration match for this event; skipping label updates')
      return
    }

    log(`Matched action: ${matchedAction}`)

    const { selectedLabelsToAssign, selectedLabelsToRemove } =
      getLabelsIdsToMutate(githubAction, labels)

    if (!(client && prInfo.nodeId)) {
      core.setFailed(`There was an error`)
      return
    }

    const hasRemoval = selectedLabelsToRemove.length > 0
    const hasAssign = selectedLabelsToAssign.length > 0
    if (!hasRemoval && !hasAssign) {
      log('No labels to add or remove for this action')
      return
    }

    const labelNamesById = (ids: string[]) =>
      ids
        .map((id) => {
          const label = labels.find((l) => l.id === id)
          return label ? label.name : id
        })
        .join(', ')

    if (hasRemoval) {
      log(`Removing labels: ${labelNamesById(selectedLabelsToRemove)}`)
      await removeLabelsFromLabelable(
        client,
        prInfo.nodeId,
        selectedLabelsToRemove
      )
    }

    if (hasAssign) {
      log(`Adding labels: ${labelNamesById(selectedLabelsToAssign)}`)
      await addLabelsToLabelable(client, prInfo.nodeId, selectedLabelsToAssign)
    }
    log('Finished successfully')
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

const createLabels = async (client, configObj, labels, prInfo) => {
  try {
    const { createLabels: labelsToCreate } = configObj
    const existentLabels = labels.map((l) => l.name)
    const [owner, repo] = prInfo.repoName.split('/')
    if (labelsToCreate && labelsToCreate.length) {
      await Promise.all(
        labelsToCreate.map((label) => {
          if (!existentLabels.includes(label.name)) {
            log(`Creating missing label: ${label.name}`)
            return client.issues.createLabel({ ...label, owner, repo })
          }
        })
      )
    }
  } catch (error) {
    log('Failed to create labels:', error)
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

function getPRInfo(): PRInfo | undefined {
  const pr = github.context.payload.pull_request
  const review = github.context.payload.review
  const repo = github.context.payload.repository

  if (!(pr && repo && repo.full_name)) {
    return
  }

  return {
    nodeId: pr.node_id,
    state: pr.state,
    merged: pr.merged,
    assignees: pr.assignees || [],
    assignee: pr.assignees,
    requested_reviewers: pr.requested_reviewers || [],
    reviewState: review ? review.state : null,
    labels: pr.labels,
    repoName: repo.full_name,
  }
}

async function getLabels(
  client: github.GitHub,
  fullName: string
): Promise<Pick<Label, 'name' | 'id'>[]> {
  const [owner, repo] = fullName.split('/')
  const result = await client.graphql(
    `query Labels($repo: String!, $owner: String!) {
      repository(name: $repo, owner: $owner) {
        labels(first: 90) {
          nodes {
            id
            name
          }
        }
      }
    }
  `,
    {
      repo,
      owner,
    }
  )

  const repository = result.repository
  if (!repository || !repository.labels || !repository.labels.nodes) {
    throw new Error(
      `Could not load labels for repository "${fullName}". Repository may not exist or be inaccessible.`
    )
  }
  return repository.labels.nodes
}

function getLabelsIdsToMutate(
  action: PRAction,
  labels: Pick<Label, 'name' | 'id'>[]
): LabelsIdsToMutate {
  let selectedLabelsToAssign: string[] = []
  let selectedLabelsToRemove: string[] = []

  if (action.set) {
    selectedLabelsToAssign = _.chain(labels)
      .filter((label) => action.set!.includes(label.name))
      .map('id')
      .value()
  }

  if (action.remove) {
    selectedLabelsToRemove = _.chain(labels)
      .filter((label) => action.remove!.includes(label.name))
      .map('id')
      .value()
  }
  return {
    selectedLabelsToAssign,
    selectedLabelsToRemove,
  }
}

async function addLabelsToLabelable(
  client: github.GitHub,
  labelableNodeId: string,
  labelIds: string[]
): Promise<void> {
  await client.graphql(
    `mutation AddLabels($input: AddLabelsToLabelableInput!) {
      addLabelsToLabelable(input: $input) {
        clientMutationId
      }
    }
  `,
    {
      input: {
        labelableId: labelableNodeId,
        labelIds,
      },
    }
  )
}

async function removeLabelsFromLabelable(
  client: github.GitHub,
  labelableNodeId: string,
  labelIds: string[]
): Promise<void> {
  await client.graphql(
    `mutation RemoveLabels($input: RemoveLabelsFromLabelableInput!) {
      removeLabelsFromLabelable(input: $input) {
        clientMutationId
      }
    }
  `,
    {
      input: {
        labelableId: labelableNodeId,
        labelIds,
      },
    }
  )
}

run()
