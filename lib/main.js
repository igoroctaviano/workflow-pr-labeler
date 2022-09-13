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
        let labels = await getLabels(client, prInfo.repoName);
        if (!labels.length) {
            core.setFailed('There are no labels in this project');
            return;
        }
        const promises = [];
        const existentLabels = labels.map((l) => l.name);
        const [owner, repo] = prInfo.repoName.split('/');
        if (configObj.createLabels && configObj.createLabels.length) {
            configObj.createLabels.forEach((label) => {
                if (!existentLabels.includes(label.name)) {
                    console.log(`Creating label: ${label.name}`);
                    promises.push(client.issues.createLabel({ ...label, owner, repo }));
                }
            });
        }
        if (promises.length) {
            await Promise.all(promises);
            labels = await getLabels(client, prInfo.repoName);
        }
        console.log('Github context:', github.context.payload);
        console.log('PR info:', prInfo);
        let githubActions = [];
        if (prInfo.state === 'open' && configObj.onOpen) {
            githubActions.push(configObj.onOpen);
        }
        if (prInfo.reviewState === 'pending' && configObj.onReviewPending) {
            githubActions.push(configObj.onReviewPending);
        }
        if (prInfo.reviewState === 'commented' && configObj.onComment) {
            githubActions.push(configObj.onComment);
        }
        if (prInfo.merged === true && configObj.onMerge) {
            githubActions.push(configObj.onMerge);
        }
        if (prInfo.merged !== true &&
            prInfo.state === 'closed' &&
            configObj.onClose) {
            githubActions.push(configObj.onClose);
        }
        if (prInfo.reviewState === 'approved' && configObj.onApprove) {
            githubActions.push(configObj.onApprove);
        }
        if (prInfo.reviewState === 'changes_requested' &&
            configObj.onChangeRequest) {
            githubActions.push(configObj.onChangeRequest);
        }
        if (!githubActions) {
            core.setFailed('There is no configuration for this action');
            return;
        }
        console.log('PR current actions based on pull request and review state:', githubActions);
        const { selectedLabelsToAssign, selectedLabelsToRemove } = getLabelsIdsToMutate(githubActions, labels);
        if (!(client && prInfo.nodeId)) {
            core.setFailed(`There was an error`);
            return;
        }
        if (!selectedLabelsToAssign.length) {
            console.log('No labels to assign');
            return;
        }
        if (selectedLabelsToRemove && selectedLabelsToRemove.length) {
            console.log('Removing labels:', selectedLabelsToRemove);
            await removeLabelsFromLabelable(client, prInfo.nodeId, selectedLabelsToRemove);
        }
        if (selectedLabelsToAssign && selectedLabelsToAssign.length) {
            console.log('Assigning labels:', selectedLabelsToAssign);
            await addLabelsToLabelable(client, prInfo.nodeId, selectedLabelsToAssign);
        }
    }
    catch (error) {
        core.setFailed(error.message);
    }
    console.log('Done!');
}
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
        assignees: pr.assignees,
        assignee: pr.assignees,
        requested_reviewers: pr.requested_reviewers,
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
    const labels = result.repository.labels.nodes;
    return labels;
}
function getLabelsIdsToMutate(actions, labels) {
    let selectedLabelsToAssign = [];
    let selectedLabelsToRemove = [];
    actions.forEach((action) => {
        if (action.set) {
            selectedLabelsToAssign = selectedLabelsToAssign.concat(_.chain(labels)
                .filter((label) => action.set.includes(label.name))
                .map('id')
                .value());
        }
        if (action.remove) {
            selectedLabelsToRemove = selectedLabelsToRemove.concat(_.chain(labels)
                .filter((label) => action.remove.includes(label.name))
                .map('id')
                .value());
        }
    });
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
