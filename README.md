# Workflow PR Labeler

Update and assign pull request labels given configuration

## Debugging

## Create a config file in the root of your project
```yml
createLabels:
  - name: Approved
    description: Approved
    color: '#01AEEB'
  - name: Changes Requested
    description: Approved
    color: '#01AEEB'
  - name: Comment
    description: Approved
    color: '#01AEEB'
  - name: Open
    description: Open
    color: '#01AEEB'
  - name: Closed
    description: Closed
    color: '#01AEEB'
  - name: Merged
    description: Merged
    color: '#01AEEB'

onComment:
  remove:
    - Approved
    - Changes Requested
  set:
    - Comment

onApprove:
  remove:
    - Comment
    - Changes Requested
  set:
    - Approved

onChangeRequest:
  remove:
    - Comment
    - Approved
  set:
    - Changes Requested

onOpen:
  set:
    - Open

onMerge:
  remove:
    - Closed
    - Open
    - Comment
    - Approved
    - Changes Requested
  set:
    - Merged

onClose:
  remove:
    - Merged
    - Open
    - Comment
    - Approved
    - Changes Requested
  set:
    - Closed
```

## Create a workflow:
```yml
name: Assign pull request labels based on labeler configuration

on: [pull_request, pull_request_review, pull_request_review_comment]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@master
    - name: Labeler
      uses: igoroctaviano/workflow-pr-labeler@master
      with:
        GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}"
        CONFIG_PATH: labeler-config.yml
```