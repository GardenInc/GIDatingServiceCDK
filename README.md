# Welcome to Garden Inc Service CDK TypeScript Package

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Some Useful commands

- `npm run build` compile typescript to js
- `npm run watch` watch for changes and compile
- `npm run test` perform the jest unit tests
- `npx cdk deploy` deploy this stack to your default AWS account/region
- `npx cdk diff` compare deployed stack with current state
- `npx cdk synth"` emits the synthesized CloudFormation template
- `npm run prettier:fix` fixes linter errors found in code

## Access to accounts

You need to setup access to accounts using `aws configure --profile <profile>` cmds. More information can be found [here](https://docs.aws.amazon.com/cli/latest/reference/configure/). If developing on the backend, you should have access to the following accounts.

- Personal: <personal-account-id>
  - everyone should have their own personal account if you don't, please follow the steps below in the Setup Personal Account section
- Tooling account: `682033486425`
- Beta account: `954976299693`
- Prod account: `724772068831`

Should be able to run following commands to see if you have access to deploy to these accounts from your local:

`aws configure list-profiles`

```
    default
    beta
    tooling
    prod
    personal
```

`aws sts get-caller-identity --profile <profile>`

```
    "UserId": <account-id>,
    "Account": <account-id>,
    "Arn": "arn:aws:iam::<account-id>:root"
```

## Setup Personal Account

## TODD

- Better acccess to accounts than using key to access (so multiple people can access)
- Finish detailed Readme
- Setup service package

- add info on how pipeline works and get working.
- update info on cloudformation templates and deploy them
