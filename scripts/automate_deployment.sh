#!/bin/bash
# Prerequisites: 
# - Set up .aws/credentials profiles for pipeline, beta, and prod
# - Set PIPELINE_ACCOUNT_ID, BETA_ACCOUNT_ID, and PROD_ACCOUNT_ID env variables
# - Clone repo with CloudFormation templates and CDK code locally
# - Initialize and bootstrap CDK in the Pipeline account
# - Install and configure git

# If prerequisite account values aren't set, exit
if [[ -z "${PIPELINE_ACCOUNT_ID}" || -z "${BETA_ACCOUNT_ID}" || -z "${PROD_ACCOUNT_ID}" ]]; then
  printf "Please set PIPELINE_ACCOUNT_ID, BETA_ACCOUNT_ID, and PROD_ACCOUNT_ID"
  printf "PIPELINE_ACCOUNT_ID =" ${PIPELINE_ACCOUNT_ID}
  printf "BETA_ACCOUNT_ID =" ${BETA_ACCOUNT_ID}
  printf "PROD_ACCOUNT_ID =" ${PROD_ACCOUNT_ID}
  exit
fi

# Deploy roles without policies so the ARNs exist when the CDK Stack is deployed in parallel
printf "\nDeploying roles to BETA and Prod\n"
aws cloudformation deploy --template-file cfnRolesTemplates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile beta \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Beta &

aws cloudformation deploy --template-file cfnRolesTemplates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile beta \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Beta &

aws cloudformation deploy --template-file cfnRolesTemplates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Prod &
    
aws cloudformation deploy --template-file cfnRolesTemplates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Prod 

# Deploy Pipeline CDK stack, write output to a file to gather key arn
printf "\nDeploying Cross-Account Deployment Pipeline Stack\n"
npm install
npm audit fix
npm run build
cdk synth

CDK_OUTPUT_FILE='.cdk_output'
rm -rf ${CDK_OUTPUT_FILE} .cfn_outputs
npx cdk deploy PipelineDeploymentStack \
  --context prod-account=${PROD_ACCOUNT_ID} \
  --context beta-account=${BETA_ACCOUNT_ID} \
  --profile pipeline \
  --require-approval never \
  2>&1 | tee -a ${CDK_OUTPUT_FILE}
sed -n -e '/Outputs:/,/^$/ p' ${CDK_OUTPUT_FILE} > .cfn_outputs
KEY_ARN=$(awk -F " " '/KeyArn/ { print $3 }' .cfn_outputs)

# Check that KEY_ARN is set after the CDK deployment
if [[ -z "${KEY_ARN}" ]]; then
  printf "\nSomething went wrong - we didn't get a Key ARN as an output from the CDK Pipeline deployment"
  exit
fi

# Update the CloudFormation roles with the Key ARNy in parallel
printf "\nUpdating roles with policies in BETA and Prod\n"
aws cloudformation deploy --template-file cfnRolesTemplates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile beta \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Beta KeyArn=${KEY_ARN} &

aws cloudformation deploy --template-file cfnRolesTemplates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile beta \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Beta KeyArn=${KEY_ARN} &

aws cloudformation deploy --template-file cfnRolesTemplates/CloudFormationDeploymentRole.yml \
    --stack-name CloudFormationDeploymentRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Prod KeyArn=${KEY_ARN} &

aws cloudformation deploy --template-file cfnRolesTemplates/CodePipelineCrossAccountRole.yml \
    --stack-name CodePipelineCrossAccountRole \
    --capabilities CAPABILITY_NAMED_IAM \
    --profile prod \
    --parameter-overrides PipelineAccountID=${PIPELINE_ACCOUNT_ID} Stage=Prod KeyArn=${KEY_ARN} 

# Commit initial code to new repo (which will trigger a fresh pipeline execution)
printf "\nCommitting code to repository\n"
git add . && git commit -m "Automated Commit" && git push

# Get deployed API Gateway endpoints
printf "\nUse the following commands to get the Endpoints for deployed environemnts: "
printf "\n  aws cloudformation describe-stacks --stack-name ProdServiceStackuswest2 \
  --profile beta | grep OutputValue"
printf "\n  aws cloudformation describe-stacks --stack-name BetaServiceStackuswest2 \
  --profile prod | grep OutputValue"

# Clean up temporary files
rm ${CDK_OUTPUT_FILE} .cfn_outputs