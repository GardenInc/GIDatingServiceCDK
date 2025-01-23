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
- Pipeline account: `739275451028`
- Beta account: `954976299693`
- Prod account: `724772068831`

```
export PIPELINE_ACCOUNT_ID=739275451028 && export BETA_ACCOUNT_ID=954976299693 && export PROD_ACCOUNT_ID=724772068831
```

Should be able to run following commands to see if you have access to deploy to these accounts from your local:

`aws configure list-profiles`

```
    default
    beta
    pipeline
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

## Pipeline TODO:

- Make Cluster stack
- get pipeline to automatically deploy cross account stacks to not have to manually deploy everytime.

- Clean constants in here and rename stacks with appropriate names
- Create templates dynamically (or change them to deploy allow all stacks to be deployed from pipeline)
- dynamically call automation_deployment.sh

This is the really good example I used: https://github.com/aws-samples/automate-cross-account-cicd-cfn-cdk/blob/main/README.md
