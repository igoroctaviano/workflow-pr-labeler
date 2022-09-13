import * as core from '@actions/core'
import * as github from '@actions/github'
import * as _ from 'lodash'
import * as yaml from 'js-yaml'
import * as fs from 'fs'

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
  reviewState:
    | 'commented'
    | 'approved'
    | 'changes_requested'
    | 'dismissed'
    | 'pending' /** PullRequestReviewState */
  state: 'merged' | 'closed' | 'open' /** PullRequestState */
  merged: boolean
  assignees: []
  requested_reviewers: []
  assignee: string
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

    const promises: Promise<any>[] = []
    const existentLabels = labels.map((l) => l.name)
    const [owner, repo] = prInfo.repoName.split('/')
    if (configObj.createLabels && configObj.createLabels.length) {
      configObj.createLabels.forEach((label) => {
        if (!existentLabels.includes(label.name)) {
          console.log(`Creating label: ${label.name}`)
          promises.push(client.issues.createLabel({ ...label, owner, repo }))
        }
      })
    }
    await Promise.all(promises)

    console.log('Github context:', github.context.payload)
    console.log('PR info:', prInfo)

    let githubActions: PRAction[] = []
    if (prInfo.state === 'open' && configObj.onOpen) {
      githubActions.push(configObj.onOpen)
    }
    if (prInfo.reviewState === 'pending' && configObj.onReviewPending) {
      githubActions.push(configObj.onReviewPending)
    }
    if (prInfo.reviewState === 'commented' && configObj.onComment) {
      githubActions.push(configObj.onComment)
    }
    if (prInfo.merged === true && configObj.onMerge) {
      githubActions.push(configObj.onMerge)
    }
    if (
      prInfo.merged !== true &&
      prInfo.state === 'closed' &&
      configObj.onClose
    ) {
      githubActions.push(configObj.onClose)
    }
    if (prInfo.reviewState === 'approved' && configObj.onApprove) {
      githubActions.push(configObj.onApprove)
    }
    if (
      prInfo.reviewState === 'changes_requested' &&
      configObj.onChangeRequest
    ) {
      githubActions.push(configObj.onChangeRequest)
    }

    if (!githubActions) {
      core.setFailed('There is no configuration for this action')
      return
    }

    console.log(
      'PR current actions based on pull request and review state:',
      githubActions
    )

    const { selectedLabelsToAssign, selectedLabelsToRemove } =
      getLabelsIdsToMutate(githubActions, labels)

    if (!(client && prInfo.nodeId)) {
      core.setFailed(`There was an error`)
      return
    }

    if (!selectedLabelsToAssign.length) {
      console.log('No labels to assign')
      return
    }

    if (selectedLabelsToRemove && selectedLabelsToRemove.length) {
      console.log('Removing labels:', selectedLabelsToRemove)
      await removeLabelsFromLabelable(
        client,
        prInfo.nodeId,
        selectedLabelsToRemove
      )
    }

    if (selectedLabelsToAssign && selectedLabelsToAssign.length) {
      console.log('Assigning labels:', selectedLabelsToAssign)
      await addLabelsToLabelable(client, prInfo.nodeId, selectedLabelsToAssign)
    }
  } catch (error) {
    core.setFailed(error.message)
  }
  console.log('Done!')
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
    assignees: pr.assignees,
    assignee: pr.assignees,
    requested_reviewers: pr.requested_reviewers,
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

  const labels = result.repository.labels.nodes
  return labels
}

function getLabelsIdsToMutate(
  actions: PRAction[],
  labels: Pick<Label, 'name' | 'id'>[]
): LabelsIdsToMutate {
  let selectedLabelsToAssign: string[] = []
  let selectedLabelsToRemove: string[] = []
  actions.forEach((action) => {
    if (action.set) {
      selectedLabelsToAssign = selectedLabelsToAssign.concat(
        _.chain(labels)
          .filter((label) => action.set!.includes(label.name))
          .map('id')
          .value()
      )
    }

    if (action.remove) {
      selectedLabelsToRemove = selectedLabelsToRemove.concat(
        _.chain(labels)
          .filter((label) => action.remove!.includes(label.name))
          .map('id')
          .value()
      )
    }
  })
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
