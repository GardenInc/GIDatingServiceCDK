#!/bin/bash

# Run this script in the tools account to clean up what was deployed
# Prerequisites: 
# - Set up .aws/credentials profiles for pipeline, beta, and prod
# - Set TOOLS_ACCOUNT_ID env variable
# - Deploy the solution using automate_deployment.sh

# If prerequisite account values aren't set, exit
if [[ -z "${TOOLS_ACCOUNT_ID}" ]]; then
  printf "Please set TOOLS_ACCOUNT_ID, BETA_ACCOUNT_ID, and PROD_ACCOUNT_ID"
  printf "TOOLS_ACCOUNT_ID =" ${TOOLS_ACCOUNT_ID}
  exit
fi

# Delete CloudFormation deployments in BETA and Prod accts
aws cloudformation delete-stack --stack-name BetaApplicationDeploymentStack --profile beta &
aws cloudformation delete-stack --stack-name ProdApplicationDeploymentStack --profile prod &

# Empty artifact bucket in pipeline acct (prerequisite for destroying the pipeline stack and its S3 bucket)
aws s3 rm s3://artifact-bucket-${TOOLS_ACCOUNT_ID} --recursive --profile pipeline

# Destroy Cross-Account Pipeline
cdk destroy CrossAccountPipelineStack --profile pipeline

# Delete Cross-Account roles
aws cloudformation delete-stack --stack-name CodePipelineCrossAccountRole --profile beta &
aws cloudformation delete-stack --stack-name CodePipelineCrossAccountRole --profile prod &
aws cloudformation delete-stack --stack-name CloudFormationDeploymentRole --profile beta & 
aws cloudformation delete-stack --stack-name CloudFormationDeploymentRole --profile prod &

# Delete repository stack
cdk destroy RepositoryStack --profile pipeline 