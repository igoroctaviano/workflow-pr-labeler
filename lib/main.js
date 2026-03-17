"use strict";
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const _ = __importStar(require("lodash"));
const yaml = __importStar(require("js-yaml"));
const fs = __importStar(require("fs"));
const LOG_PREFIX = '[workflow-pr-labeler]';
function log(message, ...args) {
    console.log(LOG_PREFIX, message, ...args);
}
async function run() {
    try {
        const token = core.getInput('GITHUB_TOKEN', { required: true });
        const configPath = core.getInput('CONFIG_PATH', { required: true });
        const configObj = yaml.safeLoad(fs.readFileSync(configPath, 'utf8'));
        if (!configObj) {
            core.setFailed('There is no configuration to set the labels');
            return;
        }
        const prInfo = getPRInfo();
        if (!prInfo) {
            return;
        }
        const client = new github.GitHub(token);
        const labels = await getLabels(client, prInfo.repoName);
        if (!labels.length) {
            core.setFailed('There are no labels in this project');
            return;
        }
        await createLabels(client, configObj, labels, prInfo);
        log('GitHub context payload', github.context.payload);
        log('PR info', prInfo);
        const payload = github.context.payload;
        log(`Event: ${payload.action || 'unknown'}, PR #${(payload.pull_request && payload.pull_request.number) || '?'}, state: ${prInfo.state}`);
        let githubAction;
        let matchedAction = null;
        if (prInfo.state === 'open' &&
            configObj.onOpen &&
            github.context.payload.action === 'opened') {
            matchedAction = 'onOpen';
            githubAction = configObj.onOpen;
        }
        if (prInfo.reviewState === 'pending' && configObj.onReviewPending) {
            matchedAction = 'onReviewPending';
            githubAction = configObj.onReviewPending;
        }
        if (prInfo.reviewState === 'commented' && configObj.onComment) {
            matchedAction = 'onComment';
            githubAction = configObj.onComment;
        }
        if (prInfo.reviewState === 'approved' && configObj.onApprove) {
            matchedAction = 'onApprove';
            githubAction = configObj.onApprove;
        }
        if (prInfo.reviewState === 'changes_requested' &&
            configObj.onChangeRequest) {
            matchedAction = 'onChangeRequest';
            githubAction = configObj.onChangeRequest;
        }
        if (prInfo.merged === true && configObj.onMerge) {
            matchedAction = 'onMerge';
            githubAction = configObj.onMerge;
        }
        if (prInfo.merged !== true &&
            prInfo.state === 'closed' &&
            configObj.onClose) {
            matchedAction = 'onClose';
            githubAction = configObj.onClose;
        }
        /** Review requested or re-requested: payload has no review, so reviewState is null */
        const isReviewRequested = github.context.payload.action === 'review_requested' &&
            prInfo.requested_reviewers.length > 0 &&
            !prInfo.reviewState;
        if (isReviewRequested && configObj.onReRequestReview) {
            matchedAction = 'onReRequestReview';
            githubAction = configObj.onReRequestReview;
        }
        /** Fallback: treat review_requested as "review pending" if onReRequestReview not set */
        if (isReviewRequested && !githubAction && configObj.onReviewPending) {
            matchedAction = 'onReviewPending (review_requested fallback)';
            githubAction = configObj.onReviewPending;
        }
        if (!githubAction) {
            log('No configuration match for this event; skipping label updates');
            return;
        }
        log(`Matched action: ${matchedAction}`);
        const { selectedLabelsToAssign, selectedLabelsToRemove } = getLabelsIdsToMutate(githubAction, labels);
        if (!(client && prInfo.nodeId)) {
            core.setFailed(`There was an error`);
            return;
        }
        const hasRemoval = selectedLabelsToRemove.length > 0;
        const hasAssign = selectedLabelsToAssign.length > 0;
        if (!hasRemoval && !hasAssign) {
            log('No labels to add or remove for this action');
            return;
        }
        const labelNamesById = (ids) => ids
            .map((id) => {
            const label = labels.find((l) => l.id === id);
            return label ? label.name : id;
        })
            .join(', ');
        if (hasRemoval) {
            log(`Removing labels: ${labelNamesById(selectedLabelsToRemove)}`);
            await removeLabelsFromLabelable(client, prInfo.nodeId, selectedLabelsToRemove);
        }
        if (hasAssign) {
            log(`Adding labels: ${labelNamesById(selectedLabelsToAssign)}`);
            await addLabelsToLabelable(client, prInfo.nodeId, selectedLabelsToAssign);
        }
        log('Finished successfully');
    }
    catch (error) {
        core.setFailed(error instanceof Error ? error.message : String(error));
    }
}
const createLabels = async (client, configObj, labels, prInfo) => {
    try {
        const { createLabels: labelsToCreate } = configObj;
        const existentLabels = labels.map((l) => l.name);
        const [owner, repo] = prInfo.repoName.split('/');
        if (labelsToCreate && labelsToCreate.length) {
            await Promise.all(labelsToCreate.map((label) => {
                if (!existentLabels.includes(label.name)) {
                    log(`Creating missing label: ${label.name}`);
                    return client.issues.createLabel({ ...label, owner, repo });
                }
            }));
        }
    }
    catch (error) {
        log('Failed to create labels:', error);
        core.setFailed(error instanceof Error ? error.message : String(error));
    }
};
function getPRInfo() {
    const pr = github.context.payload.pull_request;
    const review = github.context.payload.review;
    const repo = github.context.payload.repository;
    if (!(pr && repo && repo.full_name)) {
        return;
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
    };
}
async function getLabels(client, fullName) {
    const [owner, repo] = fullName.split('/');
    const result = await client.graphql(`query Labels($repo: String!, $owner: String!) {
      repository(name: $repo, owner: $owner) {
        labels(first: 90) {
          nodes {
            id
            name
          }
        }
      }
    }
  `, {
        repo,
        owner,
    });
    const repository = result.repository;
    if (!repository || !repository.labels || !repository.labels.nodes) {
        throw new Error(`Could not load labels for repository "${fullName}". Repository may not exist or be inaccessible.`);
    }
    return repository.labels.nodes;
}
function getLabelsIdsToMutate(action, labels) {
    let selectedLabelsToAssign = [];
    let selectedLabelsToRemove = [];
    if (action.set) {
        selectedLabelsToAssign = _.chain(labels)
            .filter((label) => action.set.includes(label.name))
            .map('id')
            .value();
    }
    if (action.remove) {
        selectedLabelsToRemove = _.chain(labels)
            .filter((label) => action.remove.includes(label.name))
            .map('id')
            .value();
    }
    return {
        selectedLabelsToAssign,
        selectedLabelsToRemove,
    };
}
async function addLabelsToLabelable(client, labelableNodeId, labelIds) {
    await client.graphql(`mutation AddLabels($input: AddLabelsToLabelableInput!) {
      addLabelsToLabelable(input: $input) {
        clientMutationId
      }
    }
  `, {
        input: {
            labelableId: labelableNodeId,
            labelIds,
        },
    });
}
async function removeLabelsFromLabelable(client, labelableNodeId, labelIds) {
    await client.graphql(`mutation RemoveLabels($input: RemoveLabelsFromLabelableInput!) {
      removeLabelsFromLabelable(input: $input) {
        clientMutationId
      }
    }
  `, {
        input: {
            labelableId: labelableNodeId,
            labelIds,
        },
    });
}
run();
